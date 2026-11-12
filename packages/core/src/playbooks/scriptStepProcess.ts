import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { basicEnvironment, killProcessGroup } from '../git/scriptProcess.js';

export interface ScriptStepRun {
  path: string;
  args: readonly string[];
  /** The variables the cell declares, resolved; the daemon's basic environment is added under them. */
  env: Readonly<Record<string, string>>;
  workingDirectory: string;
  timeoutMs: number;
  /** The most characters of stdout and stderr together that the step keeps in memory; the caller adds the length of its longest secret, so that a secret across its cap stays whole. */
  maxRetainedChars: number;
  /** Aborting kills the process group of the script. */
  signal: AbortSignal;
}

export type ScriptStepOutcome =
  | { kind: 'exited'; exitCode: number | null; output: string }
  | { kind: 'timeout'; output: string }
  | { kind: 'aborted'; output: string }
  | { kind: 'spawn_failed'; output: '' };

export interface ScriptStepClock {
  /** Calls `onElapsed` once after `delayMs` and returns the function that cancels it; tests inject a clock they drive by hand. */
  startTimer: (onElapsed: () => void, delayMs: number) => () => void;
}

const realClock: ScriptStepClock = {
  startTimer: (onElapsed, delayMs) => {
    const timer = setTimeout(onElapsed, delayMs);
    return () => clearTimeout(timer);
  },
};

const TERMINATION_GRACE_MS = 2_000;
const STREAMS_CLOSE_GRACE_MS = 200;
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Drops the characters a screen cannot render and keeps the newline and the tab. Applied after masking: a secret may hold such a character. */
export const withoutControlCharacters = (text: string): string => text.replace(UNRENDERABLE, (character) => (character === '\n' || character === '\t' ? character : ''));

const SPAWN_FAILED: ScriptStepOutcome = { kind: 'spawn_failed', output: '' };

/** The child process, or undefined when `spawn` throws (a variable holding a NUL, for one): the error carries the offending value, so it is dropped here. */
function spawnedProcess(run: ScriptStepRun): ChildProcess | undefined {
  try {
    return spawn(run.path, [...run.args], { cwd: run.workingDirectory, env: { ...basicEnvironment(process.env), ...run.env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return undefined;
  }
}

/**
 * Starts the file with no shell, in its own process group, with the daemon's basic environment plus the variables given, and answers how it ended. It never throws.
 * Stdout and stderr are decoded as they arrive and kept as printed, control characters included, together up to `maxRetainedChars`; the rest is dropped, so a script that never stops printing holds a bounded amount of memory.
 * When the script ends (exit, timeout or abort) every process left in its group is killed before the answer. At the timeout, or when the signal aborts, the group first gets SIGTERM, then SIGKILL after a grace period.
 * Every timer is cancelled when the step is answered: no signal reaches the group afterwards.
 */
export function runScriptStep(run: ScriptStepRun, clock: ScriptStepClock = realClock): Promise<ScriptStepOutcome> {
  return new Promise<ScriptStepOutcome>((resolve) => {
    const child = spawnedProcess(run);
    if (child === undefined) return resolve(SPAWN_FAILED);

    let retained = '';
    let timedOut = false;
    let wasAborted = false;
    let isFinished = false;
    let exit: { code: number | null } | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let streamsGraceTimer: NodeJS.Timeout | undefined;

    const output = () => retained;
    const outcomeAfterExit = (): ScriptStepOutcome => {
      if (wasAborted) return { kind: 'aborted', output: output() };
      if (timedOut) return { kind: 'timeout', output: output() };
      return { kind: 'exited', exitCode: exit?.code ?? null, output: output() };
    };
    const finish = (outcome: ScriptStepOutcome): void => {
      if (isFinished) return;
      isFinished = true;
      cancelTimeout();
      clearTimeout(hardKillTimer);
      clearTimeout(streamsGraceTimer);
      run.signal.removeEventListener('abort', abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };
    const terminate = (): void => {
      const isAlreadyTerminating = hardKillTimer !== undefined;
      if (child.pid === undefined || isAlreadyTerminating) return;
      killProcessGroup(child.pid, 'SIGTERM');
      hardKillTimer = setTimeout(() => {
        killProcessGroup(child.pid!, 'SIGKILL');
        finish(outcomeAfterExit());
      }, TERMINATION_GRACE_MS);
      hardKillTimer.unref();
    };

    const retain = (text: string): void => {
      const room = run.maxRetainedChars - retained.length;
      if (room <= 0 || text === '') return;
      retained += text.slice(0, room);
    };
    const retainStream = (stream: NodeJS.ReadableStream | null): void => {
      const decoder = new StringDecoder('utf8');
      stream?.on('data', (chunk: Buffer) => retain(decoder.write(chunk)));
      stream?.on('end', () => retain(decoder.end()));
    };
    retainStream(child.stdout);
    retainStream(child.stderr);

    const cancelTimeout = clock.startTimer(() => { timedOut = true; terminate(); }, run.timeoutMs);
    const abort = (): void => { wasAborted = true; terminate(); };
    if (run.signal.aborted) abort();
    else run.signal.addEventListener('abort', abort, { once: true });

    child.on('error', () => finish(SPAWN_FAILED));
    child.on('exit', (code) => {
      exit = { code };
      // Whatever the script left running in its group dies with the step, whether it succeeded or not.
      killProcessGroup(child.pid!, 'SIGKILL');
      // A process that escaped the group and holds the output open must not hold the run: wait briefly for the streams, then answer.
      streamsGraceTimer = setTimeout(() => finish(outcomeAfterExit()), STREAMS_CLOSE_GRACE_MS);
    });
    child.on('close', () => finish(outcomeAfterExit()));
  });
}
