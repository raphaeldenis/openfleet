import * as z from 'zod';
import { isBlankText } from './isBlankText.js';

export const TRIGGER_WHEN_SOURCES = ['session_state', 'silent_run', 'data_store_query', 'cron', 'integration_records'] as const;
export type TriggerWhenSource = (typeof TRIGGER_WHEN_SOURCES)[number];

export const TRIGGER_RUN_KINDS = ['prompt_manager', 'notify', 'prompt_session', 'close_session', 'run_playbook'] as const;
export type TriggerRunKind = (typeof TRIGGER_RUN_KINDS)[number];

/** Scape's name for prompt_manager, accepted on input and never stored. */
export const PROMPT_MANAGER_ALIAS = 'prompt_argus';

export const TRIGGER_SESSION_STATES = ['waiting_permission', 'idle', 'closed_with_error'] as const;
export const TRIGGER_STORE_EVENTS = ['new_matching_rows', 'row_count', 'row_updated'] as const;
export const TRIGGER_ROW_COUNT_OPS = ['eq', 'gt', 'gte', 'lt', 'lte'] as const;
export const TRIGGER_INTEGRATION_EVENTS = ['new_record', 'record_removed', 'field_changed'] as const;
export const TRIGGER_CRON_CATCH_UPS = ['skip', 'run_once', 'run_all'] as const;
export const TRIGGER_BATCH_MODES = ['per_event', 'per_batch'] as const;
export const TRIGGER_BACKLOG_POLICIES = ['fire_all', 'fire_latest_only', 'discard_stale'] as const;
export const TRIGGER_LEDGER_STATES = ['accepted', 'attempted', 'completed', 'cancelled', 'needs_review'] as const;
export type TriggerLedgerState = (typeof TRIGGER_LEDGER_STATES)[number];
/** Why a fire ended `cancelled` or `needs_review`; a fire that completed has none. */
export const TRIGGER_FIRE_REASONS = [
  'interrupted', 'stale', 'superseded', 'batched', 'disarmed', 'target_unavailable', 'target_not_eligible', 'cooldown', 'daily_cap', 'breaker_open', 'chain_depth', 'action_failed',
] as const;
export type TriggerFireReason = (typeof TRIGGER_FIRE_REASONS)[number];

/** The twelve operators of the condition evaluator of the playbook kernel; a test in core keeps the two lists equal. */
export const TRIGGER_CONDITION_OPERATORS = [
  'contains', 'ends_with', 'eq', 'exists', 'gt', 'gte', 'lt', 'lte', 'neq', 'not_contains', 'not_exists', 'starts_with',
] as const;
export type TriggerConditionOperator = (typeof TRIGGER_CONDITION_OPERATORS)[number];
export const TRIGGER_CONDITION_JOINS = ['and', 'or'] as const;
export const MAX_TRIGGER_CONDITIONS = 32;

const OPERATORS_WITHOUT_VALUE: readonly TriggerConditionOperator[] = ['exists', 'not_exists'];

const MAX_TEXT_CHARS = 8192;
const MAX_NAME_CHARS = 200;
const MAX_MINUTES = 7 * 24 * 60;

const text = (maxChars = MAX_NAME_CHARS) => z.string().min(1).max(maxChars);
const nonBlankText = (maxChars = MAX_TEXT_CHARS) => z.string().max(maxChars).refine((value) => !isBlankText(value), 'must not be blank');
const minutes = z.int().min(1).max(MAX_MINUTES);

const isKnownTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
};

const CRON_FIELD = /^[0-9A-Za-z*,/\-?]+$/;
const isFiveFieldCron = (expression: string): boolean => {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
};

const SessionStateWhenSchema = z.strictObject({
  source: z.literal('session_state'),
  state: z.enum(TRIGGER_SESSION_STATES),
  minutes: minutes.optional(),
}).refine(({ state, minutes: waited }) => state === 'closed_with_error' || waited !== undefined, { message: 'waiting_permission and idle need minutes', path: ['minutes'] });

const SilentRunWhenSchema = z.strictObject({ source: z.literal('silent_run'), minutes });

const DataStoreQueryWhenSchema = z.strictObject({
  source: z.literal('data_store_query'),
  storeId: text(),
  event: z.enum(TRIGGER_STORE_EVENTS),
  op: z.enum(TRIGGER_ROW_COUNT_OPS).optional(),
  value: z.number().refine(Number.isFinite, 'must be a finite number').optional(),
}).refine(({ event, op, value }) => event !== 'row_count' || (op !== undefined && value !== undefined), { message: 'row_count needs op and value', path: ['event'] });

const CronWhenSchema = z.strictObject({
  source: z.literal('cron'),
  expression: z.string().refine(isFiveFieldCron, 'must be a cron expression of five fields'),
  timezone: z.string().refine(isKnownTimeZone, 'must be an IANA time zone'),
  catchUp: z.enum(TRIGGER_CRON_CATCH_UPS).default('skip'),
});

const IntegrationRecordsWhenSchema = z.strictObject({
  source: z.literal('integration_records'),
  itemId: text(),
  event: z.enum(TRIGGER_INTEGRATION_EVENTS),
  field: text().optional(),
}).refine(({ event, field }) => event !== 'field_changed' || field !== undefined, { message: 'field_changed needs field', path: ['field'] });

/** The WHEN of a trigger. Only the shape of the configuration is validated; the engine that fires them is not in this schema. */
export const TriggerWhenSchema = z.union([SessionStateWhenSchema, SilentRunWhenSchema, DataStoreQueryWhenSchema, CronWhenSchema, IntegrationRecordsWhenSchema]);
export type TriggerWhen = z.infer<typeof TriggerWhenSchema>;

const RUN_MEMBERS = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prompt_manager'), managerId: text().optional(), prompt: nonBlankText() }),
  z.strictObject({ kind: z.literal('notify'), title: nonBlankText(MAX_NAME_CHARS), message: nonBlankText() }),
  z.strictObject({ kind: z.literal('prompt_session'), sessionId: text(), prompt: nonBlankText() }),
  z.strictObject({ kind: z.literal('close_session'), sessionId: text() }),
  z.strictObject({ kind: z.literal('run_playbook'), playbookId: text(), inputs: z.record(z.string(), z.unknown()).optional() }),
]);

const withManagerAliasesResolved = (run: unknown): unknown => {
  const isAliased = typeof run === 'object' && run !== null && (run as { kind?: unknown }).kind === PROMPT_MANAGER_ALIAS;
  if (!isAliased) return run;
  const { kind: _alias, argusId, ...rest } = run as Record<string, unknown>;
  return { kind: 'prompt_manager', ...rest, ...(argusId === undefined ? {} : { managerId: argusId }) };
};

/** The RUN of a trigger; prompt_argus and argusId are read as prompt_manager and managerId. */
export const TriggerRunSchema = z.preprocess(withManagerAliasesResolved, RUN_MEMBERS) as z.ZodType<z.infer<typeof RUN_MEMBERS>, unknown>;
export type TriggerRun = z.infer<typeof RUN_MEMBERS>;

export const TriggerPolicySchema = z.strictObject({
  cooldownSeconds: z.int().min(0).default(0),
  maxFiresPerDay: z.int().min(1).optional(),
  batchMode: z.enum(TRIGGER_BATCH_MODES).default('per_event'),
  backlogPolicy: z.enum(TRIGGER_BACKLOG_POLICIES).default('fire_all'),
  backlogMaxAgeMinutes: z.int().min(1).optional(),
});
export type TriggerPolicy = z.infer<typeof TriggerPolicySchema>;

const CONDITION_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

const conditionFields = {
  lhs: z.string().max(MAX_NAME_CHARS).regex(CONDITION_PATH, 'must be a dotted path such as event.row.title'),
  op: z.enum(TRIGGER_CONDITION_OPERATORS),
  rhs: z.union([z.string().max(MAX_TEXT_CHARS), z.number().refine(Number.isFinite, 'must be finite'), z.boolean()]).optional(),
  join: z.enum(TRIGGER_CONDITION_JOINS).default('and'),
  caseInsensitive: z.boolean().default(false),
};

const needsValue = ({ op, rhs }: { op: TriggerConditionOperator; rhs?: unknown }): boolean => OPERATORS_WITHOUT_VALUE.includes(op) || rhs !== undefined;
const withoutValueForExistence = <T extends { op: TriggerConditionOperator; rhs?: unknown }>(condition: T): T =>
  (OPERATORS_WITHOUT_VALUE.includes(condition.op) ? { ...condition, rhs: undefined } : condition);

/** A condition as written by a caller: no id yet. exists and not_exists ignore rhs, every other operator needs it. */
export const TriggerConditionInputSchema = z.strictObject(conditionFields)
  .refine(needsValue, { message: 'this operator compares to a value: give rhs', path: ['rhs'] })
  .transform(withoutValueForExistence);
export type TriggerConditionInput = z.input<typeof TriggerConditionInputSchema>;

export const TriggerConditionSchema = z.strictObject({ id: z.string().min(1), ...conditionFields })
  .refine(needsValue, { message: 'this operator compares to a value: give rhs', path: ['rhs'] })
  .transform(withoutValueForExistence);
export type TriggerCondition = z.output<typeof TriggerConditionSchema>;

/** The namespaces of the event a condition may read, by source: a path outside them is refused with the right ones named. */
export const EVENT_PREFIXES_BY_SOURCE: Readonly<Record<TriggerWhenSource, readonly string[]>> = {
  session_state: ['event.session.'],
  silent_run: ['event.session.'],
  data_store_query: ['event.row.', 'event.previous.'],
  cron: ['event.slot.'],
  integration_records: ['event.record.', 'event.previous.'],
};

export const DEFAULT_TRIGGER_WHEN: TriggerWhen = { source: 'session_state', state: 'idle', minutes: 10 };
export const DEFAULT_TRIGGER_RUN: TriggerRun = { kind: 'notify', title: 'Trigger fired', message: 'A trigger fired.' };
