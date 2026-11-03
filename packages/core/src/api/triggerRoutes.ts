import { TRIGGER_LEDGER_STATES, TriggerPolicySchema, TriggerRunSchema, TriggerWhenSchema } from '@openfleet/shared';
import { z } from 'zod';
import { fireViewOf, type FireLedger } from '../triggers/fireLedger.js';
import type { TriggerContent } from '../triggers/triggerRepository.js';
import type { TriggerService } from '../triggers/triggerService.js';
import { json, queryParams, type Router } from './router.js';

export const HUMAN_PROOF_HEADER = 'x-human-proof';

const ConditionsSchema = z.array(z.record(z.string(), z.unknown()));
const RevisionSchema = z.int().min(1);

const FiresQuerySchema = z.object({
  state: z.enum(TRIGGER_LEDGER_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const ListQuerySchema =z.object({ projectId: z.string().min(1) });
const OwnerManagerIdSchema = z.string().min(1).nullable();
const CreateBodySchema = z.strictObject({
  projectId: z.string().min(1), ownerManagerId: OwnerManagerIdSchema, title: z.string().optional(), when: TriggerWhenSchema.optional(), conditions: ConditionsSchema.optional(),
  run: TriggerRunSchema.optional(), policy: TriggerPolicySchema.optional(),
});
const ReplaceBodySchema = z.strictObject({
  expectedRev: RevisionSchema, ownerManagerId: OwnerManagerIdSchema.optional(), title: z.string().optional(), when: TriggerWhenSchema.optional(), conditions: ConditionsSchema.optional(),
  run: TriggerRunSchema.optional(), policy: TriggerPolicySchema.optional(),
});
const ArmBodySchema = z.strictObject({ approvedRev: RevisionSchema });

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * The human side of the triggers: every route sits under /api, behind the admin token; none sits under /mcp, so no agent arms.
 * Arming also needs the single-use proof of a human gesture, which the admin token alone does not give.
 */
export function registerTriggerRoutes(router: Router, deps: { triggers: TriggerService; fires: Pick<FireLedger, 'listOfTrigger'> }): void {
  const { triggers, fires } = deps;

  router.add('GET', '/api/triggers/:id/fires', ({ req, res, params }) => {
    const { state, limit } = FiresQuerySchema.parse(queryParams(req));
    const trigger = triggers.getById(params.id!);
    json(res, 200, { fires: fires.listOfTrigger(trigger.id, { limit, ...(state !== undefined && { state }) }).map(fireViewOf) });
  });

  router.add('GET', '/api/triggers', ({ req, res }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, triggers.list(projectId));
  });

  router.add('POST', '/api/triggers', ({ res, body }) => {
    json(res, 201, triggers.create(CreateBodySchema.parse(body)));
  });

  router.add('GET', '/api/triggers/:id', ({ res, params }) => {
    json(res, 200, triggers.getById(params.id!));
  });

  router.add('PUT', '/api/triggers/:id', ({ res, params, body }) => {
    const { expectedRev, ownerManagerId, title, when, conditions, run, policy } = ReplaceBodySchema.parse(body);
    const replacement: TriggerContent = {
      ...(ownerManagerId !== undefined && { ownerManagerId }), ...(title !== undefined && { title }), ...(when !== undefined && { when }), ...(run !== undefined && { run }), ...(policy !== undefined && { policy }),
      ...(conditions !== undefined && { conditions: triggers.conditionsWithIds(conditions) }),
    };
    json(res, 200, triggers.edit(params.id!, () => replacement, { expectedRev }));
  });

  router.add('DELETE', '/api/triggers/:id', ({ res, params }) => {
    triggers.delete(params.id!);
    json(res, 200, { deleted: params.id! });
  });

  router.add('POST', '/api/triggers/:id/arm', ({ req, res, params, body }) => {
    const { approvedRev } = ArmBodySchema.parse(body);
    json(res, 200, triggers.arm({ id: params.id!, approvedRev, proof: headerValue(req.headers[HUMAN_PROOF_HEADER]) }));
  });

  router.add('POST', '/api/triggers/:id/disarm', ({ res, params }) => {
    json(res, 200, triggers.disarm(params.id!));
  });
}
