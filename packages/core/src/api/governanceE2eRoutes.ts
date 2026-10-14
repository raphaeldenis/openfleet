import { z } from 'zod';
import type { GovernanceQueueService } from '../governance/governanceQueueService.js';
import { json, type Router } from './router.js';

const ProposeLawBodySchema = z.object({ text: z.string(), incident: z.string() });

/** End-to-end only: files a pending law for a manager through the real queue, the way its MCP tool does. Registered only when OPENFLEET_E2E is set. */
export function registerGovernanceE2eRoutes(router: Router, deps: { governanceQueue: GovernanceQueueService }): void {
  router.add('POST', '/api/managers/:id/fake-propose-law', ({ res, params, body }) => {
    const { text, incident } = ProposeLawBodySchema.parse(body);
    json(res, 200, deps.governanceQueue.proposeLaw({ managerId: params.id!, text, incident }));
  });
}
