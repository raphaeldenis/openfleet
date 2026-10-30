import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { maskedSecrets } from '../redact.js';

export type ScriptStartFailureReason = 'not_found' | 'unsafe_permissions' | 'not_executable';
export type ScriptRunFailureReason = 'timeout' | 'exit_nonzero' | 'spawn_failed';

export interface ScriptFailure {
  reason: ScriptRunFailureReason;
  exitCode?: number;
  /** The redacted last bytes of the script's stdout and stderr; absent when the script never started. */
  outputTail?: string;
}

export interface ScriptRun {
  script: string;
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputTailBytes: number;
}

const TERMINATION_GRACE_MS = 2_000;
const STREAMS_CLOSE_GRACE_MS = 200;
const GROUP_OR_OTHERS_CAN_WRITE = 0o022;
const FORWARDED_VARIABLES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL']);
const FORWARDED_PREFIXES = ['LC_'];
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The daemon's basic environment only: its own variables (tokens, session markers) never reach a script. */
export function basicEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forwarded = Object.entries(parentEnv).filter(([name, value]) => value !== undefined && (FORWARDED_VARIABLES.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix))));
  return Object.fromEntries(forwarded);
}

/** The reason a regular file cannot be started safely, or undefined when it can: an executable file owned by the daemon's user and writable by its owner only. */
export function unstartableReasonOf(script: string): ScriptStartFailureReason | undefined {
  try {
    const stats = statSync(realpathSync(script));
    if (!stats.isFile()) return 'not_found';
    const isOwnedByAnotherUser = process.getuid !== undefined && stats.uid !== process.getuid();
    if (isOwnedByAnotherUser) return 'unsafe_permissions';
    const isWritableByGroupOrOthers = (stats.mode & GROUP_OR_OTHERS_CAN_WRITE) !== 0;
    if (isWritableByGroupOrOthers) return 'unsafe_permissions';
    accessSync(script, constants.X_OK);
    return undefined;
  } catch (error) {
    const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR';
    return isMissing ? 'not_found' : 'not_executable';
  }
}

function readableTail(tail: Buffer, wasCut: boolean, maxBytes: number): string {
  const decoded = tail.toString('utf8');
  const withoutPartialFirstLine = wasCut && decoded.includes('\n') ? decoded.slice(decoded.indexOf('\n') + 1) : decoded;
  const withoutControlCharacters = withoutPartialFirstLine.replace(UNRENDERABLE, (character) => (character === '\n' || character === '\t' ? character : ''));
  return maskedSecrets(withoutControlCharacters).slice(-maxBytes);
}

const killProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
};

/**
 * Starts the script with no shell and no argument, as the daemon's user, and answers how it failed, or undefined when it exited 0.
 * At the timeout the script and its whole process group are killed. It never throws.
 */
export function runScript(run: ScriptRun): Promise<ScriptFailure | undefined> {
  return new Promise<ScriptFailure | undefined>((resolve) => {
    let tail = Buffer.alloc(0);
    let wasCut = false;
    let timedOut = false;
    let isFinished = false;
    let exit: { code: number | null } | undefined;

    const child = spawn(run.script, [], { cwd: run.workingDirectory, env: run.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (failure: ScriptFailure | undefined): void => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeoutTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(failure);
    };
    const outputTail = () => readableTail(tail.subarray(-run.maxOutputTailBytes), wasCut || tail.length > run.maxOutputTailBytes, run.maxOutputTailBytes);
    const failureFromExit = (): ScriptFailure | undefined => {
      if (timedOut) return { reason: 'timeout', outputTail: outputTail() };
      if (exit?.code === 0) return undefined;
      return { reason: 'exit_nonzero', ...(exit?.code != null && { exitCode: exit.code }), outputTail: outputTail() };
    };

    const keepTail = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > run.maxOutputTailBytes * 2) {
        tail = tail.subarray(-run.maxOutputTailBytes);
        wasCut = true;
      }
    };
    child.stdout?.on('data', keepTail);
    child.stderr?.on('data', keepTail);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      killProcessGroup(child.pid, 'SIGTERM');
      const hardKill = setTimeout(() => {
        killProcessGroup(child.pid!, 'SIGKILL');
        finish(failureFromExit());
      }, TERMINATION_GRACE_MS);
      hardKill.unref();
    }, run.timeoutMs);

    child.on('error', () => finish({ reason: 'spawn_failed' }));
    child.on('exit', (code) => {
      exit = { code };
      // A script that leaves a background process holding its output open must not hold the worktree creation: wait briefly for the streams, then answer.
      setTimeout(() => finish(failureFromExit()), STREAMS_CLOSE_GRACE_MS);
    });
    child.on('close', () => finish(failureFromExit()));
  });
}
