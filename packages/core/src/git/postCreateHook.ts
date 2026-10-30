import { isAbsolute } from 'node:path';
import type { PostCreateHookWarning } from '@openfleet/shared';
import { basicEnvironment, runScript, unstartableReasonOf, type ScriptStartFailureReason } from './scriptProcess.js';

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

/** The script runs with the user's basic environment only, plus the worktree context. */
function hookEnvironment(input: PostCreateHookInput, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...basicEnvironment(parentEnv),
    OPENFLEET_WORKTREE_PATH: input.worktreePath,
    OPENFLEET_BRANCH: input.branch,
    OPENFLEET_REPO_PATH: input.repoPath,
    ...(input.projectId !== undefined && { OPENFLEET_PROJECT_ID: input.projectId }),
  };
}

/** The reason the script cannot be run safely, or undefined when it can. */
export function unrunnableReasonOf(script: string): ScriptStartFailureReason | undefined {
  if (!isAbsolute(script)) return 'not_found';
  return unstartableReasonOf(script);
}

/**
 * Runs the project's post-create script in the new worktree and answers the warning to report, or undefined when it succeeded.
 * No shell and no argument: the branch and the paths reach the script as OPENFLEET_* variables only. The script runs as the daemon's
 * user, is refused when it is not an absolute, executable file writable by its owner only, and is killed with its whole process
 * group at the timeout. It never throws.
 */
export async function runPostCreateHook(input: PostCreateHookInput, options: { env?: NodeJS.ProcessEnv } = {}): Promise<PostCreateHookWarning | undefined> {
  const unrunnableReason = unrunnableReasonOf(input.script);
  if (unrunnableReason) return { type: 'post_create_hook_failed', reason: unrunnableReason };

  const failure = await runScript({
    script: input.script, workingDirectory: input.worktreePath, env: hookEnvironment(input, options.env ?? process.env), timeoutMs: input.timeoutMs, maxOutputTailBytes: MAX_OUTPUT_TAIL_BYTES,
  });
  return failure && { type: 'post_create_hook_failed', ...failure };
}
