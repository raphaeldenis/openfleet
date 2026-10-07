import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { OpenFleetError, type RemovedWorktree, type WorktreeEntry, type WorktreeList } from '@openfleet/shared';
import { listRepoWorktrees, mainWorktreeOf, notRemovableReasonOf, removeWorktree, type RepoWorktree } from '../git/worktreeInventory.js';
import { ProjectNotFoundError } from '../projects/projectErrors.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { SessionService } from '../sessions/sessionService.js';

export interface WorktreeServiceDeps {
  projects: Pick<ProjectRepository, 'get'>;
  sessions: Pick<SessionService, 'list' | 'directoryRealpathOf'>;
  worktreesRoot: string;
  env?: NodeJS.ProcessEnv;
}

const realPathOrSelf = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

const isSameOrInside = (candidate: string, directory: string): boolean => candidate === directory || candidate.startsWith(`${directory}${sep}`);

/**
 * Lists and removes the worktrees of the git repositories a project works in. A project's repositories are the ones its sessions
 * run in (any state): the project row holds no repository list. A worktree is in use while a session that is not closed works
 * in it or in one of its subdirectories.
 */
export class WorktreeService {
  constructor(private readonly deps: WorktreeServiceDeps) {}

  async listForProject(projectId: string, query?: string): Promise<WorktreeList> {
    const repoPaths = await this.repositoriesOf(projectId);
    const perRepository = await Promise.all(repoPaths.map((repoPath) => this.entriesOf(repoPath)));
    return withMatching(perRepository.flat(), query);
  }

  async listForRepository(repoPath: string, query?: string): Promise<WorktreeList> {
    return withMatching(await this.entriesOf(repoPath), query);
  }

  /** Removes the worktree when it belongs to one of the project's repositories; a path of any other directory is not found, never deleted. */
  async removeForProject(projectId: string, worktreePath: string): Promise<RemovedWorktree> {
    for (const repoPath of await this.repositoriesOf(projectId)) {
      try {
        return await this.removeFromRepository(repoPath, worktreePath);
      } catch (error) {
        const isNotInThisRepository = error instanceof OpenFleetError && error.code === 'not_found';
        if (!isNotInThisRepository) throw error;
      }
    }
    throw new OpenFleetError('not_found', 'the worktree does not exist.');
  }

  removeFromRepository(repoPath: string, worktreePath: string): Promise<RemovedWorktree> {
    return removeWorktree({
      repoPath, worktreePath, worktreesRoot: this.deps.worktreesRoot, env: this.deps.env,
      findLiveSessionIn: (worktree) => this.liveSessionIn(worktree.path),
    });
  }

  private async repositoriesOf(projectId: string): Promise<string[]> {
    if (!this.deps.projects.get(projectId)) throw new ProjectNotFoundError(projectId);
    const directories = this.deps.sessions.list().filter((session) => session.projectId === projectId).map((session) => session.directory);
    const mainWorktrees = await Promise.all([...new Set(directories)].map((directory) => mainWorktreeOf(directory, this.deps.env)));
    return [...new Set(mainWorktrees.filter((path): path is string => path !== undefined))];
  }

  private async entriesOf(repoPath: string): Promise<WorktreeEntry[]> {
    const worktrees = await listRepoWorktrees({ repoPath, worktreesRoot: this.deps.worktreesRoot, env: this.deps.env });
    return worktrees.map((worktree) => this.entryOf(worktree));
  }

  private entryOf(worktree: RepoWorktree): WorktreeEntry {
    const liveSessionId = this.liveSessionIn(worktree.path);
    const isInUse = liveSessionId !== undefined;
    const notRemovableReason = notRemovableReasonOf({ ...worktree, isInUse });
    return {
      repoPath: worktree.repoPath, path: worktree.path, branch: worktree.branch, head: worktree.head, isMain: worktree.isMain, isDetached: worktree.isDetached,
      isLocked: worktree.isLocked, isPrunable: worktree.isPrunable, isDirty: worktree.isDirty, isInUse, ...(isInUse && { inUseBySessionId: liveSessionId }),
      isUnderWorktreesRoot: worktree.isUnderWorktreesRoot, removable: notRemovableReason === undefined, ...(notRemovableReason && { notRemovableReason }),
    };
  }

  /** The id of a session that is not closed and works in the worktree or below it. */
  private liveSessionIn(worktreePath: string): string | undefined {
    const worktree = realPathOrSelf(worktreePath);
    const sessions = this.deps.sessions.list().filter((session) => session.state !== 'closed');
    return sessions.find((session) => this.directoriesOf(session.id, session.directory).some((directory) => isSameOrInside(directory, worktree)))?.id;
  }

  private directoriesOf(sessionId: string, directory: string): string[] {
    const recordedRealpath = this.deps.sessions.directoryRealpathOf(sessionId);
    return [directory, ...(recordedRealpath ? [recordedRealpath] : [])].map(realPathOrSelf);
  }
}

function withMatching(entries: WorktreeEntry[], query: string | undefined): WorktreeList {
  const needle = query?.trim().toLowerCase();
  const matching = needle ? entries.filter((entry) => [entry.repoPath, entry.branch ?? '', entry.path].some((text) => text.toLowerCase().includes(needle))) : entries;
  return { items: matching, total: matching.length };
}
