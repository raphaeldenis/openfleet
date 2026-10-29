import { DEFAULT_POST_CREATE_HOOK_TIMEOUT_SECONDS, type WorktreeWarning } from '@openfleet/shared';
import type { ProjectRecord } from '../projects/projectRepository.js';
import { provideHooksDirectory } from './hooksPathProvision.js';
import { runPostCreateHook } from './postCreateHook.js';
import { createWorktree } from './worktrees.js';

export interface PostCreateHook {
  script: string;
  timeoutSeconds: number;
  projectId: string;
}

const MILLISECONDS_PER_SECOND = 1000;

/** The hook a project configures, or undefined when it configures none. */
export function postCreateHookOf(project: ProjectRecord | undefined): PostCreateHook | undefined {
  if (!project?.postCreateHookScript) return undefined;
  return { script: project.postCreateHookScript, timeoutSeconds: project.postCreateHookTimeoutSeconds ?? DEFAULT_POST_CREATE_HOOK_TIMEOUT_SECONDS, projectId: project.id };
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  /** Present only when something went wrong after the worktree was created. */
  warnings?: WorktreeWarning[];
}

/**
 * Creates the worktree, gives it the repository's git hooks directory, then runs the project's post-create hook in it. A missing hooks
 * directory or a failing hook is reported as a warning and never fails the creation: the worktree exists whatever happened after.
 * A worktree that could not be created runs no hook.
 */
export async function createWorktreeWithHook(input: { repoPath: string; branchName: string; baseRef?: string; worktreesRoot: string; env?: NodeJS.ProcessEnv; hook?: PostCreateHook }): Promise<CreatedWorktree> {
  const { path, branch } = await createWorktree(input);
  const hooksWarning = await provideHooksDirectory({ repoPath: input.repoPath, worktreePath: path, env: input.env });
  const hookWarning = input.hook && await runPostCreateHook({
    script: input.hook.script, worktreePath: path, branch, repoPath: input.repoPath, projectId: input.hook.projectId, timeoutMs: input.hook.timeoutSeconds * MILLISECONDS_PER_SECOND,
  });
  const warnings = [hooksWarning, hookWarning].filter((warning): warning is WorktreeWarning => Boolean(warning));
  return warnings.length > 0 ? { path, branch, warnings } : { path, branch };
}
