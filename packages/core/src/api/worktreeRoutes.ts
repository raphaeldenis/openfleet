import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { WorktreeService } from '../worktrees/worktreeService.js';
import { json, queryParams, type Router } from './router.js';

const ListWorktreesQuerySchema = z.object({ q: z.string().optional() });
const RemoveWorktreeQuerySchema = z.object({ path: z.string().min(1).refine(isAbsolute, { message: 'path must be absolute' }) });

export function registerWorktreeRoutes(router: Router, deps: { worktrees: WorktreeService }): void {
  router.add('GET', '/api/projects/:id/worktrees', async ({ req, res, params }) => {
    const { q } = ListWorktreesQuerySchema.parse(queryParams(req));
    json(res, 200, await deps.worktrees.listForProject(params.id!, q));
  });

  router.add('DELETE', '/api/projects/:id/worktrees', async ({ req, res, params }) => {
    const { path } = RemoveWorktreeQuerySchema.parse(queryParams(req));
    json(res, 200, await deps.worktrees.removeForProject(params.id!, path));
  });
}
