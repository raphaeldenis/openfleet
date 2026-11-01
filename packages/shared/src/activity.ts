import * as z from 'zod';

export const ACTIVITY_ACTOR_KINDS = ['human', 'agent', 'system'] as const;
export const ACTIVITY_SOURCES = ['mcp', 'rest', 'hook', 'daemon'] as const;
export const ACTIVITY_OUTCOMES = ['ok', 'denied', 'error'] as const;

export const DEFAULT_ACTIVITY_PAGE_LIMIT = 50;
export const MAX_ACTIVITY_PAGE_LIMIT = 200;

/** One line of the activity log: who did what to which entity, and how it ended. Text fields are masked and bounded before storage. */
export const ActivityRowSchema = z.strictObject({
  id: z.number().int().positive(),
  at: z.string().min(1),
  actorKind: z.enum(ACTIVITY_ACTOR_KINDS),
  actorLabel: z.string(),
  sessionId: z.string().optional(),
  managerId: z.string().optional(),
  source: z.enum(ACTIVITY_SOURCES),
  action: z.string().min(1),
  entityKind: z.string().optional(),
  entityId: z.string().optional(),
  entityLabel: z.string().optional(),
  outcome: z.enum(ACTIVITY_OUTCOMES),
  durationMs: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
  argsExcerpt: z.string().optional(),
  resultExcerpt: z.string().optional(),
});
export type ActivityRow = z.infer<typeof ActivityRowSchema>;

/** One page of the log, newest first; `nextCursor` is absent on the last page. */
export const ActivityPageSchema = z.strictObject({
  items: z.array(ActivityRowSchema),
  nextCursor: z.string().optional(),
});
export type ActivityPage = z.infer<typeof ActivityPageSchema>;
