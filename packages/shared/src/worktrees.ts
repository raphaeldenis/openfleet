export const POST_CREATE_HOOK_FAILURE_REASONS = ['timeout', 'exit_nonzero', 'not_executable', 'not_found', 'unsafe_permissions', 'spawn_failed'] as const;
export type PostCreateHookFailureReason = (typeof POST_CREATE_HOOK_FAILURE_REASONS)[number];

/** What went wrong after a worktree was created; the worktree itself exists whatever the warning says. */
export interface WorktreeWarning {
  type: 'post_create_hook_failed';
  reason: PostCreateHookFailureReason;
  exitCode?: number;
  /** The redacted tail of the script's stdout and stderr. */
  outputTail?: string;
}

/** Why a worktree cannot be removed; `in_use` is answered as `directory_in_use`, every other reason as `constraint_violation` with `detail.reason`. */
export const WORKTREE_REFUSAL_REASONS = ['main', 'detached', 'locked', 'dirty', 'in_use', 'outside_root', 'submodules', 'status_failed', 'missing', 'removal_refused'] as const;
export type WorktreeRefusalReason = (typeof WORKTREE_REFUSAL_REASONS)[number];

export interface WorktreeEntry {
  repoPath: string;
  path: string;
  /** Null for a detached HEAD. */
  branch: string | null;
  head: string;
  isMain: boolean;
  isDetached: boolean;
  isLocked: boolean;
  /** The directory is gone but git still lists the worktree. */
  isPrunable: boolean;
  isDirty: boolean;
  isInUse: boolean;
  inUseBySessionId?: string;
  isUnderWorktreesRoot: boolean;
  removable: boolean;
  notRemovableReason?: WorktreeRefusalReason;
}

export interface WorktreeList {
  items: WorktreeEntry[];
  total: number;
}

export interface RemovedWorktree {
  removed: string;
  /** The branch is kept: removing a worktree never deletes it. */
  branch: string | null;
  /** Ignored files (node_modules, .env, build output) are deleted with the worktree; absent when git could not count them. */
  ignoredFileCount?: number;
}
