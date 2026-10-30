import { ESCALATION_STATUSES, EscalationAnswerBodySchema, OpenFleetError } from '@openfleet/shared';
import { z } from 'zod';
import type { EscalationService } from '../escalation/escalationService.js';
import { json, queryParams, type Router } from './router.js';

const ListEscalationsQuerySchema = z.object({ status: z.enum(ESCALATION_STATUSES).default('pending') });

/** The human side of the escalation ladder: every route sits under /api, behind the admin token; none sits under /mcp, so a session's token never answers an escalation. */
export function registerEscalationRoutes(router: Router, deps: { escalations: EscalationService; isManager: (sessionId: string) => boolean }): void {
  const { escalations, isManager } = deps;

  router.add('GET', '/api/escalations', ({ req, res }) => {
    const { status } = ListEscalationsQuerySchema.parse(queryParams(req));
    json(res, 200, escalations.listByStatus(status));
  });

  router.add('GET', '/api/managers/:id/escalations', ({ res, params }) => {
    const managerId = params.id!;
    if (!isManager(managerId)) throw new OpenFleetError('manager_not_found', 'the manager does not exist.');
    json(res, 200, escalations.listOfManager(managerId));
  });

  router.add('POST', '/api/escalations/:id/answer', ({ res, params, body }) => {
    const { answers } = EscalationAnswerBodySchema.parse(body);
    json(res, 200, escalations.answer({ escalationId: params.id!, answers }));
  });

  router.add('POST', '/api/escalations/:id/retry-handover', ({ res, params }) => {
    json(res, 200, escalations.retryHandover(params.id!));
  });
}
