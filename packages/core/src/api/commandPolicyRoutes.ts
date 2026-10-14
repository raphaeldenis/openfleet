import { CommandPolicyEvaluateRequestSchema, type PolicyRequest } from '@openfleet/shared';
import * as z from 'zod';
import type { CommandPolicyService } from '../policy/commandPolicyService.js';
import { decodeDenialCursor } from '../policy/denialCursor.js';
import type { DenialReader } from '../policy/ports.js';
import { json, queryParams, type Router } from './router.js';

const DEFAULT_DENIALS_PAGE_SIZE = 50;
const MAX_DENIALS_PAGE_SIZE = 200;

const DenialsQuerySchema = z.object({
  manager: z.string().min(1).optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DENIALS_PAGE_SIZE).default(DEFAULT_DENIALS_PAGE_SIZE),
  cursor: z.string().min(1).refine((cursor) => decodeDenialCursor(cursor) !== undefined, { message: 'the cursor is not one this daemon issued' }).optional(),
});

function triedRequestOf(body: unknown): PolicyRequest {
  const tried = CommandPolicyEvaluateRequestSchema.parse(body);
  return {
    sessionId: 'command-policy-try',
    harness: tried.harness,
    ...(tried.role === undefined ? {} : { role: tried.role }),
    ...(tried.model === undefined ? {} : { model: tried.model }),
    presence: tried.presence,
    actor: tried.actor,
    source: 'pre_tool_use',
    toolName: tried.toolName,
    command: tried.command,
    cwd: tried.cwd,
    worktreeRoot: tried.cwd,
    scratchRoots: [],
  };
}

/** The human side of the command policy: every route sits under /api behind the admin token, none under /mcp, so a session cannot read or change its own policy. */
export function registerCommandPolicyRoutes(router: Router, deps: { policy: CommandPolicyService; denials: DenialReader }): void {
  const { policy, denials } = deps;

  router.add('GET', '/api/command-policy', ({ res }) => json(res, 200, policy.view()));

  router.add('PUT', '/api/command-policy', ({ res, body }) => json(res, 200, policy.replace(body)));

  router.add('POST', '/api/command-policy/evaluate', ({ res, body }) => json(res, 200, policy.evaluate(triedRequestOf(body))));

  router.add('GET', '/api/command-policy/denials', ({ req, res }) => {
    const { manager, since, limit, cursor } = DenialsQuerySchema.parse(queryParams(req));
    json(res, 200, denials.list({ limit, ...(manager === undefined ? {} : { managerId: manager }), ...(since === undefined ? {} : { since }), ...(cursor === undefined ? {} : { cursor }) }));
  });
}
