import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PostCreateHookFailureReason, WorktreeWarning } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';

export interface PostCreateHookInput {
  /** The project's configured script: an absolute path, never taken from a tool argument. */
  script: string;
  worktreePath: string;
  branch: string;
  repoPath: string;
  projectId?: string;
  timeoutMs: number;
}

const MAX_OUTPUT_TAIL_BYTES = 8192;
const TERMINATION_GRACE_MS = 2_000;
const STREAMS_CLOSE_GRACE_MS = 200;
const GROUP_OR_OTHERS_CAN_WRITE = 0o022;
const FORWARDED_VARIABLES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL']);
const FORWARDED_PREFIXES = ['LC_'];
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The script runs with the user's basic environment only: the daemon's own variables (tokens, session markers) never reach it. */
function hookEnvironment(input: PostCreateHookInput, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forwarded = Object.entries(parentEnv).filter(([name, value]) => value !== undefined && (FORWARDED_VARIABLES.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix))));
  return {
    ...Object.fromEntries(forwarded),
    OPENFLEET_WORKTREE_PATH: input.worktreePath,
    OPENFLEET_BRANCH: input.branch,
    OPENFLEET_REPO_PATH: input.repoPath,
    ...(input.projectId !== undefined && { OPENFLEET_PROJECT_ID: input.projectId }),
  };
}

/** The reason the script cannot be run safely, or undefined when it can. */
export function unrunnableReasonOf(script: string): Extract<PostCreateHookFailureReason, 'not_found' | 'unsafe_permissions' | 'not_executable'> | undefined {
  if (!isAbsolute(script)) return 'not_found';
  try {
    const stats = statSync(realpathSync(script));
    if (!stats.isFile()) return 'not_found';
    const isWritableByGroupOrOthers = (stats.mode & GROUP_OR_OTHERS_CAN_WRITE) !== 0;
    if (isWritableByGroupOrOthers) return 'unsafe_permissions';
    accessSync(script, constants.X_OK);
    return undefined;
  } catch (error) {
    const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR';
    return isMissing ? 'not_found' : 'not_executable';
  }
}

function readableTail(tail: Buffer, wasCut: boolean): string {
  const decoded = tail.toString('utf8');
  const withoutPartialFirstLine = wasCut && decoded.includes('\n') ? decoded.slice(decoded.indexOf('\n') + 1) : decoded;
  const withoutControlCharacters = withoutPartialFirstLine.replace(UNRENDERABLE, (character) => (character === '\n' || character === '\t' ? character : ''));
  return maskedSecrets(withoutControlCharacters).slice(-MAX_OUTPUT_TAIL_BYTES);
}

const failure = (reason: PostCreateHookFailureReason, extra: Partial<WorktreeWarning> = {}): WorktreeWarning => ({ type: 'post_create_hook_failed', reason, ...extra });

const killProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
};

/**
 * Runs the project's post-create script in the new worktree and answers the warning to report, or undefined when it succeeded.
 * No shell and no argument: the branch and the paths reach the script as OPENFLEET_* variables only. The script runs as the daemon's
 * user, is refused when it is not an absolute, executable file writable by its owner only, and is killed with its whole process
 * group at the timeout. It never throws.
 */
export async function runPostCreateHook(input: PostCreateHookInput, options: { env?: NodeJS.ProcessEnv } = {}): Promise<WorktreeWarning | undefined> {
  const unrunnableReason = unrunnableReasonOf(input.script);
  if (unrunnableReason) return failure(unrunnableReason);

  return new Promise<WorktreeWarning | undefined>((resolve) => {
    let tail = Buffer.alloc(0);
    let wasCut = false;
    let timedOut = false;
    let isFinished = false;
    let exit: { code: number | null } | undefined;

    const child = spawn(input.script, [], {
      cwd: input.worktreePath, env: hookEnvironment(input, options.env ?? process.env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (warning: WorktreeWarning | undefined): void => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeoutTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(warning);
    };
    const outputTail = () => readableTail(tail.subarray(-MAX_OUTPUT_TAIL_BYTES), wasCut || tail.length > MAX_OUTPUT_TAIL_BYTES);
    const warningFromExit = (): WorktreeWarning | undefined => {
      if (timedOut) return failure('timeout', { outputTail: outputTail() });
      if (exit?.code === 0) return undefined;
      return failure('exit_nonzero', { ...(exit?.code != null && { exitCode: exit.code }), outputTail: outputTail() });
    };

    const keepTail = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > MAX_OUTPUT_TAIL_BYTES * 2) {
        tail = tail.subarray(-MAX_OUTPUT_TAIL_BYTES);
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
        finish(warningFromExit());
      }, TERMINATION_GRACE_MS);
      hardKill.unref();
    }, input.timeoutMs);

    child.on('error', () => finish(failure('spawn_failed')));
    child.on('exit', (code) => {
      exit = { code };
      // A script that leaves a background process holding its output open must not hold the worktree creation: wait briefly for the streams, then answer.
      setTimeout(() => finish(warningFromExit()), STREAMS_CLOSE_GRACE_MS);
    });
    child.on('close', () => finish(warningFromExit()));
  });
}
