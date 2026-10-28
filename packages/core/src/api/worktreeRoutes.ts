import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { WorktreeService } from '../worktrees/worktreeService.js';
import { json, queryParams, type Router } from './router.js';

const ListWorktreesQuerySchema = z.object({ q: z.string().optional() });
const RemoveWorktreeQuerySchema = z.object({ path: z.string().min(1).refine(isAbsolute, { message: 'path must be absolute' }) });
// Only the exact text `true` removes anything; every other value is a dry run.
const StaleCleanupQuerySchema = z.object({ apply: z.string().optional() });

export function registerWorktreeRoutes(router: Router, deps: { worktrees: WorktreeService }): void {
  router.add('GET', '/api/projects/:id/worktrees', async ({ req, res, params }) => {
    const { q } = ListWorktreesQuerySchema.parse(queryParams(req));
    json(res, 200, await deps.worktrees.listForProject(params.id!, q));
  });

  router.add('POST', '/api/projects/:id/worktrees/stale-cleanup', async ({ req, res, params }) => {
    const { apply } = StaleCleanupQuerySchema.parse(queryParams(req));
    json(res, 200, await deps.worktrees.cleanStaleForProject(params.id!, { apply: apply === 'true' }));
  });

  router.add('DELETE', '/api/projects/:id/worktrees', async ({ req, res, params }) => {
    const { path } = RemoveWorktreeQuerySchema.parse(queryParams(req));
    json(res, 200, await deps.worktrees.removeForProject(params.id!, path));
  });
}
