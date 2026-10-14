import { OpenFleetError, PROPOSAL_STATUSES } from '@openfleet/shared';
import { z } from 'zod';
import type { GovernanceQueueService } from '../governance/governanceQueueService.js';
import { json, queryParams, type Router } from './router.js';

const ListProposalsQuerySchema = z.object({ status: z.enum(PROPOSAL_STATUSES).default('pending') });

const DecisionBodySchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('deny'), reason: z.string().optional() }),
]);

/** The human side of the governance queue: every route sits under /api, behind the admin token; none sits under /mcp. */
export function registerGovernanceRoutes(router: Router, deps: { governanceQueue: GovernanceQueueService }): void {
  const { governanceQueue } = deps;

  router.add('GET', '/api/governance/proposals', ({ req, res }) => {
    const { status } = ListProposalsQuerySchema.parse(queryParams(req));
    json(res, 200, governanceQueue.listByStatus(status));
  });

  router.add('GET', '/api/managers/:id/governance', ({ res, params }) => {
    const managerId = params.id!;
    if (!governanceQueue.isManager(managerId)) throw new OpenFleetError('manager_not_found', 'the manager does not exist.');
    json(res, 200, governanceQueue.viewOf(managerId));
  });

  router.add('POST', '/api/governance/proposals/:id/decide', ({ res, params, body }) => {
    const decision = DecisionBodySchema.parse(body);
    json(res, 200, governanceQueue.decide({ proposalId: params.id!, ...decision }));
  });
}
