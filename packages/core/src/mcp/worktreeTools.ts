import { MANAGER_ROLE, OpenFleetError, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sameGitRepository } from '../git/worktrees.js';
import type { WorktreeService } from '../worktrees/worktreeService.js';
import { ok, refuse } from './toolResults.js';

export interface RegisterWorktreeToolsDeps {
  worktrees: WorktreeService;
  caller: Session;
}

/** The refusal reason travels in the text an agent reads: the error line carries no structured detail. */
function withReasonInMessage(error: unknown): unknown {
  if (!(error instanceof OpenFleetError)) return error;
  const detail = error.options.detail as { reason?: unknown } | undefined;
  if (typeof detail?.reason !== 'string') return error;
  return new OpenFleetError(error.code, `${error.message} (reason: ${detail.reason})`, { hint: error.options.hint, detail: error.options.detail });
}

export function registerWorktreeTools(server: McpServer, deps: RegisterWorktreeToolsDeps): void {
  const { worktrees, caller } = deps;
  const isRootSession = caller.parentId === undefined;
  const canRemoveWorktrees = isRootSession || caller.role === MANAGER_ROLE;

  server.registerTool('list_worktrees', {
    description: 'List the git worktrees of your own repository: path, branch, whether each is dirty, detached, locked, in use by a live session, and whether it can be removed (removable, notRemovableReason). '
      + 'repo_path defaults to your own directory and must be your own repository; query keeps the worktrees whose repository, branch or path contains the text',
    inputSchema: { repo_path: z.string().optional(), query: z.string().optional() },
  }, async ({ repo_path, query }) => {
    const repoPath = repo_path ?? caller.directory;
    if (!(await sameGitRepository(caller.directory, repoPath))) return refuse('outside_own_repository', 'repo_path must be the git repository of your own session directory');
    return ok(await worktrees.listForRepository(repoPath, query));
  });

  server.registerTool('remove_worktree', {
    description: 'Remove one clean linked worktree of your own repository (managers and root sessions only). Refuses the main worktree, a worktree outside the OpenFleet worktrees root, a locked or detached one, '
      + 'one with uncommitted or untracked files, one with initialized submodules, and one a live session works in; the refusal names its reason. It never forces and never deletes the branch. '
      + 'Ignored files (node_modules, .env, build output) are not protected: they are deleted with the worktree, and ignoredFileCount in the result says how many. '
      + 'repo_path defaults to your own directory and must be your own repository; path is the worktree to remove',
    inputSchema: { repo_path: z.string().optional(), path: z.string().min(1) },
  }, async ({ repo_path, path }) => {
    if (!canRemoveWorktrees) return refuse('not_a_manager', 'only a manager or a root session may remove worktrees');
    const repoPath = repo_path ?? caller.directory;
    if (!(await sameGitRepository(caller.directory, repoPath))) return refuse('outside_own_repository', 'repo_path must be the git repository of your own session directory');
    try {
      return ok(await worktrees.removeFromRepository(repoPath, path));
    } catch (error) {
      throw withReasonInMessage(error);
    }
  });
}
