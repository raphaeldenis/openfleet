import { spawn } from 'node:child_process';
import { basicEnvironment, killProcessGroup } from '../git/scriptProcess.js';

export interface ScriptStepRun {
  path: string;
  args: readonly string[];
  /** The variables the cell declares, resolved; the daemon's basic environment is added under them. */
  env: Readonly<Record<string, string>>;
  workingDirectory: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Aborting kills the process group of the script. */
  signal: AbortSignal;
}

export type ScriptStepOutcome =
  | { kind: 'exited'; exitCode: number | null; output: string }
  | { kind: 'timeout'; output: string }
  | { kind: 'aborted'; output: string }
  | { kind: 'spawn_failed'; output: '' };

const TERMINATION_GRACE_MS = 2_000;
const STREAMS_CLOSE_GRACE_MS = 200;
const TRUNCATION_MARKER = '\n[truncated]';
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const readableOutput = (chunks: Buffer[], wasTruncated: boolean): string => {
  const decoded = Buffer.concat(chunks).toString('utf8');
  const withoutControlCharacters = decoded.replace(UNRENDERABLE, (character) => (character === '\n' || character === '\t' ? character : ''));
  return wasTruncated ? withoutControlCharacters + TRUNCATION_MARKER : withoutControlCharacters;
};

/**
 * Starts the file with no shell, in its own process group, with the daemon's basic environment plus the variables given, and answers how it ended. It never throws.
 * Stdout and stderr are kept together up to `maxOutputBytes`; the rest is dropped and the output ends with a truncation marker.
 * At the timeout, or when the signal aborts, the group gets SIGTERM, then SIGKILL after a grace period.
 */
export function runScriptStep(run: ScriptStepRun): Promise<ScriptStepOutcome> {
  return new Promise<ScriptStepOutcome>((resolve) => {
    const chunks: Buffer[] = [];
    let keptBytes = 0;
    let wasTruncated = false;
    let timedOut = false;
    let wasAborted = false;
    let isFinished = false;
    let exit: { code: number | null } | undefined;

    const child = spawn(run.path, [...run.args], { cwd: run.workingDirectory, env: { ...basicEnvironment(process.env), ...run.env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = () => readableOutput(chunks, wasTruncated);
    const outcomeAfterExit = (): ScriptStepOutcome => {
      if (wasAborted) return { kind: 'aborted', output: output() };
      if (timedOut) return { kind: 'timeout', output: output() };
      return { kind: 'exited', exitCode: exit?.code ?? null, output: output() };
    };
    const finish = (outcome: ScriptStepOutcome): void => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeoutTimer);
      run.signal.removeEventListener('abort', abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };
    const terminate = (): void => {
      if (child.pid === undefined) return;
      killProcessGroup(child.pid, 'SIGTERM');
      const hardKill = setTimeout(() => {
        killProcessGroup(child.pid!, 'SIGKILL');
        finish(outcomeAfterExit());
      }, TERMINATION_GRACE_MS);
      hardKill.unref();
    };

    const keep = (chunk: Buffer): void => {
      const room = run.maxOutputBytes - keptBytes;
      if (chunk.length > room) wasTruncated = true;
      if (room <= 0) return;
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      keptBytes += kept.length;
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);

    const timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, run.timeoutMs);
    const abort = (): void => { wasAborted = true; terminate(); };
    if (run.signal.aborted) abort();
    else run.signal.addEventListener('abort', abort, { once: true });

    child.on('error', () => finish({ kind: 'spawn_failed', output: '' }));
    child.on('exit', (code) => {
      exit = { code };
      // A script that leaves a background process holding its output open must not hold the run: wait briefly for the streams, then answer.
      setTimeout(() => finish(outcomeAfterExit()), STREAMS_CLOSE_GRACE_MS);
    });
    child.on('close', () => finish(outcomeAfterExit()));
  });
}
