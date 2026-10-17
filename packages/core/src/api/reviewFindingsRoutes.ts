import * as z from 'zod';
import { log } from '../logger.js';
import { SKIPPABLE_STEPS, type ReviewFindingsRepository } from '../review/reviewFindingsRepository.js';
import { json, queryParams, type Router } from './router.js';

const SkipBodySchema = z.object({
  ticket: z.string().trim().min(1),
  step: z.enum(SKIPPABLE_STEPS as [string, ...string[]]),
  reason: z.string().trim().min(1),
});
const SkipsQuerySchema = z.object({ ticket: z.string().min(1) });

/** The human side of the ship gate: every route sits under /api behind the admin token, none under /mcp, so no session can waive a review step. */
export function registerReviewFindingsRoutes(router: Router, deps: { findings: Pick<ReviewFindingsRepository, 'recordSkip' | 'skipsOf'>; clock?: () => string }): void {
  const { findings, clock = () => new Date().toISOString() } = deps;

  router.add('POST', '/api/review-findings/skips', ({ res, body }) => {
    const { ticket, step, reason } = SkipBodySchema.parse(body);
    const skip = { ticket, step: step as (typeof SKIPPABLE_STEPS)[number], reason, createdAt: clock() };
    findings.recordSkip(skip);
    log('info', `review step skipped by a human: ${ticket} ${step}: ${reason}`);
    json(res, 201, skip);
  });

  router.add('GET', '/api/review-findings/skips', ({ req, res }) => {
    const { ticket } = SkipsQuerySchema.parse(queryParams(req));
    json(res, 200, { items: findings.skipsOf({ ticket }) });
  });
}
