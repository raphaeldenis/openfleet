import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OpenFleetError, type RemovedWorktree, type WorktreeRefusalReason } from '@openfleet/shared';
import { isMissingPathWithin, isPathWithin, run } from './worktrees.js';

const STATUS_TIMEOUT_MS = 30_000;
const LISTING_TIMEOUT_MS = 15_000;
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
const SHORT_HEAD_CHARS = 12;
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'];
const NUL = '\0';

export interface RepoWorktree {
  /** The main worktree of the repository this one belongs to. */
  repoPath: string;
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
  isDirty: boolean;
  /** The working tree state could not be read: it is not provably clean. */
  isStatusUnknown: boolean;
  hasInitializedSubmodules: boolean;
  isUnderWorktreesRoot: boolean;
}

export interface InventoryInput { repoPath: string; worktreesRoot: string; env?: NodeJS.ProcessEnv }

const gitEnvironment = (env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({ ...(env ?? process.env), GIT_OPTIONAL_LOCKS: '0' });
const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();
const realPathOrResolved = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

interface ListedWorktree { path: string; head: string; branch: string | null; isDetached: boolean; isLocked: boolean; isPrunable: boolean; isBare: boolean }

/** Parses `git worktree list --porcelain -z`: NUL-terminated fields, an empty field between two worktrees, so a path may hold any character. */
function parsedListing(output: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const field of output.split(NUL)) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), head: '', branch: null, isDetached: false, isLocked: false, isPrunable: false, isBare: false };
      listed.push(current);
    } else if (current && field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length, 'HEAD '.length + SHORT_HEAD_CHARS);
    else if (current && field.startsWith('branch ')) current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (current && field === 'detached') current.isDetached = true;
    else if (current && (field === 'locked' || field.startsWith('locked '))) current.isLocked = true;
    else if (current && (field === 'prunable' || field.startsWith('prunable '))) current.isPrunable = true;
    else if (current && field === 'bare') current.isBare = true;
  }
  return listed;
}

async function workingTreeState(worktreePath: string, env: NodeJS.ProcessEnv | undefined): Promise<{ isDirty: boolean; isStatusUnknown: boolean }> {
  try {
    const { stdout } = await run([...NO_FSMONITOR, 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktreePath, env: gitEnvironment(env), timeoutMs: STATUS_TIMEOUT_MS, maxBufferBytes: MAX_LISTING_BYTES });
    return { isDirty: stdout.trim() !== '', isStatusUnknown: false };
  } catch {
    return { isDirty: true, isStatusUnknown: true };
  }
}

/** A submodule is initialized when `git submodule status` does not prefix it with `-`; git refuses to remove a worktree that holds one. */
async function hasInitializedSubmodules(worktreePath: string, env: NodeJS.ProcessEnv | undefined): Promise<boolean> {
  if (!existsSync(join(worktreePath, '.gitmodules'))) return false;
  try {
    const { stdout } = await run([...NO_FSMONITOR, 'submodule', 'status'], { cwd: worktreePath, env: gitEnvironment(env), timeoutMs: STATUS_TIMEOUT_MS });
    return stdout.split('\n').some((line) => line.trim() !== '' && !line.startsWith('-'));
  } catch {
    return true;
  }
}

/** The main worktree of the repository the directory belongs to; undefined when it is no git repository. */
export async function mainWorktreeOf(directory: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!isDirectory(directory)) return undefined;
  try {
    const { stdout } = await run(['worktree', 'list', '--porcelain', '-z'], { cwd: directory, env: gitEnvironment(env), timeoutMs: LISTING_TIMEOUT_MS });
    return parsedListing(stdout)[0]?.path;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'git_unavailable') throw error;
    return undefined;
  }
}

/** Every worktree of the repository `repoPath` belongs to, the main one first. A directory that is not a repository has none. */
export async function listRepoWorktrees(input: InventoryInput): Promise<RepoWorktree[]> {
  if (!isDirectory(input.repoPath)) return [];
  let listing: ListedWorktree[];
  try {
    const { stdout } = await run(['worktree', 'list', '--porcelain', '-z'], { cwd: input.repoPath, env: gitEnvironment(input.env), timeoutMs: LISTING_TIMEOUT_MS });
    listing = parsedListing(stdout);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'git_unavailable') throw error;
    return [];
  }
  const mainPath = listing[0]?.path;
  if (mainPath === undefined) return [];
  return Promise.all(listing.map(async (listed, index): Promise<RepoWorktree> => {
    const hasDirectory = !listed.isPrunable && !listed.isBare && isDirectory(listed.path);
    const state = hasDirectory ? await workingTreeState(listed.path, input.env) : { isDirty: false, isStatusUnknown: false };
    return {
      repoPath: mainPath, path: listed.path, branch: listed.branch, head: listed.head, isMain: index === 0, isDetached: listed.isDetached, isLocked: listed.isLocked,
      isPrunable: listed.isPrunable, ...state,
      hasInitializedSubmodules: hasDirectory && await hasInitializedSubmodules(listed.path, input.env),
      isUnderWorktreesRoot: (listed.isPrunable ? isMissingPathWithin : isPathWithin)(listed.path, input.worktreesRoot),
    };
  }));
}

/** The first reason, in this order, why the worktree must stay; undefined when it can be removed. */
export function notRemovableReasonOf(worktree: RepoWorktree & { isInUse?: boolean }): WorktreeRefusalReason | undefined {
  if (worktree.isMain) return 'main';
  if (!worktree.isUnderWorktreesRoot) return 'outside_root';
  if (worktree.isPrunable) return 'missing';
  if (worktree.isLocked) return 'locked';
  if (worktree.isDetached) return 'detached';
  if (worktree.isInUse) return 'in_use';
  if (worktree.isStatusUnknown) return 'status_failed';
  if (worktree.isDirty) return 'dirty';
  if (worktree.hasInitializedSubmodules) return 'submodules';
  return undefined;
}

const REFUSAL_TEXT: Record<Exclude<WorktreeRefusalReason, 'in_use'>, { message: string; hint: string }> = {
  main: { message: 'the main worktree cannot be removed.', hint: 'Remove a linked worktree instead.' },
  outside_root: { message: 'only worktrees that OpenFleet created can be removed.', hint: 'Remove it with git, from its repository.' },
  missing: { message: 'the worktree directory is gone, there is nothing to remove.', hint: 'Prune it with git, from its repository.' },
  locked: { message: 'the worktree is locked.', hint: 'Unlock it with git first.' },
  detached: { message: 'the worktree has a detached HEAD: its commits would be lost.', hint: 'Check out a branch in it first.' },
  status_failed: { message: 'the worktree state cannot be read.', hint: 'Retry; check the worktree with git status.' },
  dirty: { message: 'the worktree has uncommitted or untracked files.', hint: 'Commit, stash or delete them first.' },
  submodules: { message: 'the worktree has initialized submodules.', hint: 'Deinitialize them first.' },
  removal_refused: { message: 'git refused to remove the worktree.', hint: 'It changed while it was being removed; check it with git status.' },
};

function refusalFor(reason: WorktreeRefusalReason, liveSessionId: string | undefined): OpenFleetError {
  if (reason === 'in_use') {
    return new OpenFleetError('directory_in_use', 'a live session works in this worktree.', { hint: 'Close the session first.', detail: { reason, ...(liveSessionId && { sessionId: liveSessionId }) } });
  }
  const { message, hint } = REFUSAL_TEXT[reason];
  return new OpenFleetError('constraint_violation', message, { hint, detail: { reason } });
}

async function countIgnoredFiles(worktreePath: string, env: NodeJS.ProcessEnv | undefined): Promise<number | undefined> {
  try {
    const { stdout } = await run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: worktreePath, env: gitEnvironment(env), timeoutMs: STATUS_TIMEOUT_MS, maxBufferBytes: MAX_LISTING_BYTES });
    return stdout.split(NUL).filter((file) => file !== '').length;
  } catch {
    return undefined;
  }
}

export interface RemoveWorktreeInput extends InventoryInput {
  worktreePath: string;
  /** The id of a live session working in the given worktree, when there is one. */
  findLiveSessionIn?: (worktree: RepoWorktree) => string | undefined;
  /** Runs once every check passed, right before git is asked to remove: lets a test change the worktree in that window. */
  afterChecks?: () => void;
}

/**
 * Removes one linked worktree of the repository, or refuses with the reason. Git is asked without --force, so it re-checks the
 * working tree itself at the last moment; the branch is never deleted. Ignored files go with the directory and are counted.
 */
export async function removeWorktree(input: RemoveWorktreeInput): Promise<RemovedWorktree> {
  const target = realPathOrResolved(input.worktreePath);
  const worktrees = await listRepoWorktrees(input);
  const worktree = worktrees.find((candidate) => realPathOrResolved(candidate.path) === target);
  if (!worktree) throw new OpenFleetError('not_found', 'the worktree does not exist.');

  const liveSessionId = input.findLiveSessionIn?.(worktree);
  const refusalReason = notRemovableReasonOf({ ...worktree, isInUse: liveSessionId !== undefined });
  if (refusalReason) throw refusalFor(refusalReason, liveSessionId);

  input.afterChecks?.();
  const ignoredFileCount = await countIgnoredFiles(worktree.path, input.env);
  try {
    await run(['worktree', 'remove', '--', worktree.path], { cwd: worktree.repoPath, env: gitEnvironment(input.env), timeoutMs: STATUS_TIMEOUT_MS });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'git_unavailable') throw error;
    throw refusalFor('removal_refused', undefined);
  }
  return { removed: worktree.path, branch: worktree.branch, ...(ignoredFileCount !== undefined && { ignoredFileCount }) };
}
