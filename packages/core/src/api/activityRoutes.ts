import { ACTIVITY_ACTOR_KINDS, ACTIVITY_OUTCOMES, DEFAULT_ACTIVITY_PAGE_LIMIT, MAX_ACTIVITY_PAGE_LIMIT } from '@openfleet/shared';
import * as z from 'zod';
import type { ActivityQuery, ActivityRepository } from '../activity/activityRepository.js';
import { json, queryParams, type Router } from './router.js';

const canonicalUtcInstant = (instant: string): string => new Date(instant).toISOString();
const InstantSchema = z.iso.datetime({ offset: true }).transform(canonicalUtcInstant);

const ActivityQuerySchema = z.object({
  actor: z.enum(ACTIVITY_ACTOR_KINDS).optional(),
  session: z.string().min(1).optional(),
  manager: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  outcome: z.enum(ACTIVITY_OUTCOMES).optional(),
  since: InstantSchema.optional(),
  until: InstantSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ACTIVITY_PAGE_LIMIT).default(DEFAULT_ACTIVITY_PAGE_LIMIT),
  cursor: z.string().regex(/^\d+$/, 'the cursor is not one this daemon issued').optional(),
});

const activityQueryOf = (query: z.infer<typeof ActivityQuerySchema>): ActivityQuery => ({
  limit: query.limit,
  ...(query.actor === undefined ? {} : { actorKind: query.actor }),
  ...(query.session === undefined ? {} : { sessionId: query.session }),
  ...(query.manager === undefined ? {} : { managerId: query.manager }),
  ...(query.entity === undefined ? {} : { entityKind: query.entity }),
  ...(query.action === undefined ? {} : { action: query.action }),
  ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
  ...(query.since === undefined ? {} : { since: query.since }),
  ...(query.until === undefined ? {} : { until: query.until }),
  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

/**
 * The human side of the activity log: read only, under /api behind the admin token, none under /mcp, so a session cannot read the log.
 * `manager` filters by the root of a lineage: the rows of that session, of every manager beneath it and of all their sessions.
 * `since` and `until` take an ISO 8601 instant with or without milliseconds, in UTC (`Z`) or with an offset (`+02:00`), and compare it as the UTC instant it names.
 * A row holds no command and no free text: `argsExcerpt` keeps only numbers, booleans, UUIDs, identifiers and members of the closed set of their key, of at most 64 characters,
 * under a key a registered tool names and that names no secret; every other text reads `[text len=N]` and an unknown key reads `[key len=N]` with its value hidden;
 * `resultExcerpt` reads `[result len=N]` and the scalar fields that pass the same list; `detail` is an error code of the grammar, an error class name or the daemon version;
 * the labels are safe tokens and the ids safe tokens or UUIDs, any other text reading `[text len=N]`.
 */
export function registerActivityRoutes(router: Router, deps: { reader: Pick<ActivityRepository, 'list'> }): void {
  router.add('GET', '/api/activity', ({ req, res }) => {
    json(res, 200, deps.reader.list(activityQueryOf(ActivityQuerySchema.parse(queryParams(req)))));
  });
}
