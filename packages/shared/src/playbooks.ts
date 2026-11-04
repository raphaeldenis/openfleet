import * as z from 'zod';
import { isBlankText } from './isBlankText.js';
import { MAX_TRIGGER_CONDITIONS, TriggerConditionInputSchema } from './triggers.js';

export const PLAYBOOK_CELL_KINDS = ['script', 'http', 'readFromStore', 'writeToStore', 'tool', 'manual', 'waitFor', 'subPlaybook'] as const;
export type PlaybookCellKind = (typeof PLAYBOOK_CELL_KINDS)[number];

/** Kinds of the second wave: named so a refusal can say they are coming, never accepted by the schemas. */
export const RESERVED_PLAYBOOK_CELL_KINDS = ['claudePrompt', 'claudeSession', 'customTool', 'calendarEvent'] as const;

export const PLAYBOOK_VALUE_TYPES = ['string', 'number', 'bool', 'json'] as const;
export type PlaybookValueType = (typeof PLAYBOOK_VALUE_TYPES)[number];

export const PLAYBOOK_ORIGINS = ['native', 'imported', 'agent'] as const;
export type PlaybookOrigin = (typeof PLAYBOOK_ORIGINS)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export const HTTP_AUTH_TYPES = ['bearer', 'basic'] as const;

export const MAX_PLAYBOOK_CELLS = 200;
export const MAX_PLAYBOOK_INPUTS = 32;
export const MAX_SCRIPT_ARGUMENTS = 64;
export const MAX_SCRIPT_ENV_ENTRIES = 32;
export const MAX_HTTP_HEADERS = 32;
export const MAX_EDGES_PER_CELL = 32;
export const MAX_OUTPUTS_PER_CELL = 32;
export const MAX_ROW_MAPPINGS = 64;
export const MAX_PROMPT_CHARS = 8192;
export const MAX_TEMPLATE_CHARS = 4096;
export const MAX_URL_CHARS = 2048;
export const MAX_BODY_CHARS = 65536;
export const MAX_PROGRAM_CHARS = 1024;
export const MAX_NAME_CHARS = 200;
export const MAX_FLOW_BYTES = 1024 * 1024;
export const MAX_DATA_DEPTH = 6;
export const MAX_DATA_BYTES = 16384;
export const MAX_PLAYBOOK_VERSIONS = 10;
export const PLAYBOOK_VERSION_SOURCES = ['edit', 'restore'] as const;
export type PlaybookVersionSource = (typeof PLAYBOOK_VERSION_SOURCES)[number];
export const PLAYBOOK_RUN_STATUSES = ['running', 'succeeded', 'failed', 'needs_review'] as const;
export type PlaybookRunStatus = (typeof PLAYBOOK_RUN_STATUSES)[number];
export const PLAYBOOK_RUN_ACTOR_KINDS = ['admin'] as const;
export type PlaybookRunActorKind = (typeof PLAYBOOK_RUN_ACTOR_KINDS)[number];
export const MAX_STEP_EXECUTIONS_PER_RUN = 1000;
export const DEFAULT_STEP_TIMEOUT_SECONDS = 600;
export const MAX_STEP_OUTPUT_BYTES = 256 * 1024;
export const MAX_CONCURRENT_RUNS = 4;
export const MAX_RUNS_TO_KEEP = 1000;
export const DEFAULT_MAX_RUNS_TO_KEEP = 50;

const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const REFERENCE_PATH = /^(inputs|steps)\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

const text = (maxChars = MAX_NAME_CHARS) => z.string().min(1).max(maxChars);
const nonBlankText = (maxChars = MAX_PROMPT_CHARS) => z.string().max(maxChars).refine((value) => !isBlankText(value), 'must not be blank');
const template = z.string().max(MAX_TEMPLATE_CHARS);

const isBoundedData = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= MAX_DATA_DEPTH) return false;
  const members = Array.isArray(value) ? value : Object.values(value);
  return members.every((member) => isBoundedData(member, depth + 1));
};

const isSmallEnough = (value: unknown): boolean => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_DATA_BYTES;

/** Free JSON data (a tool input): plain values, nested at most MAX_DATA_DEPTH levels, serialized at most MAX_DATA_BYTES. */
const boundedData = z.record(text(), z.unknown()).refine(isBoundedData, `must be plain JSON nested at most ${MAX_DATA_DEPTH} levels`).refine(isSmallEnough, `must be at most ${MAX_DATA_BYTES} bytes`);

const recordOf = <V extends z.ZodType>(key: z.ZodType<string>, value: V, maxEntries: number) =>
  z.record(key, value).refine((entries) => Object.keys(entries).length <= maxEntries, `at most ${maxEntries} entries`);

const ConditionListSchema = z.array(TriggerConditionInputSchema).max(MAX_TRIGGER_CONDITIONS);

const EdgeSchema = z.strictObject({
  to: z.string().regex(CELL_ID),
  when: ConditionListSchema.optional(),
  forEach: z.string().regex(REFERENCE_PATH, 'must be inputs.<path> or steps.<id>.<path>').optional(),
  label: text().optional(),
});

const RetrySchema = z.strictObject({
  maxAttempts: z.int().min(1).max(20),
  until: ConditionListSchema,
  backoffMs: z.int().min(0).max(3_600_000),
});

const cellBase = {
  id: z.string().regex(CELL_ID, 'must be 1 to 64 letters, digits, underscores or dashes'),
  label: text().optional(),
  next: z.array(EdgeSchema).max(MAX_EDGES_PER_CELL).optional(),
  retry: RetrySchema.optional(),
  timeoutSeconds: z.int().min(1).max(86_400).optional(),
  outputs: recordOf(z.string().regex(FIELD_NAME), z.enum(PLAYBOOK_VALUE_TYPES), MAX_OUTPUTS_PER_CELL).optional(),
};

const HttpAuthSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bearer'), token: template }),
  z.strictObject({ type: z.literal('basic'), username: template, password: template }),
]);

const CELL_MEMBERS = z.discriminatedUnion('kind', [
  z.strictObject({
    ...cellBase, kind: z.literal('script'), program: text(MAX_PROGRAM_CHARS),
    args: z.array(template).max(MAX_SCRIPT_ARGUMENTS).default([]),
    env: recordOf(z.string().regex(ENV_NAME), template, MAX_SCRIPT_ENV_ENTRIES).default({}),
  }),
  z.strictObject({
    ...cellBase, kind: z.literal('http'), method: z.enum(HTTP_METHODS), url: text(MAX_URL_CHARS),
    headers: recordOf(z.string().regex(HEADER_NAME), template, MAX_HTTP_HEADERS).optional(),
    body: z.string().max(MAX_BODY_CHARS).optional(), auth: HttpAuthSchema.optional(),
  }),
  z.strictObject({
    ...cellBase, kind: z.literal('readFromStore'), storeID: text(), columns: z.array(text()).max(MAX_ROW_MAPPINGS).optional(),
    limit: z.int().min(1).max(10_000).optional(), whereColumnID: text().optional(), whereValue: template.optional(),
    sortColumnID: text().optional(), sortDescending: z.boolean().optional(),
  }),
  z.strictObject({
    ...cellBase, kind: z.literal('writeToStore'), storeID: text(),
    rowMappings: recordOf(text(), template, MAX_ROW_MAPPINGS).refine((mappings) => Object.keys(mappings).length >= 1, 'at least one column'),
    naturalKeyColumnID: text().optional(),
  }),
  z.strictObject({ ...cellBase, kind: z.literal('tool'), tool: text(), input: boundedData.optional() }),
  z.strictObject({ ...cellBase, kind: z.literal('manual'), prompt: nonBlankText() }),
  z.strictObject({ ...cellBase, kind: z.literal('waitFor'), predicate: ConditionListSchema.min(1), pollMs: z.int().min(100).max(3_600_000).optional() }),
  z.strictObject({
    ...cellBase, kind: z.literal('subPlaybook'), playbookId: text(),
    inputs: recordOf(text(), z.union([template, z.number().refine(Number.isFinite, 'must be finite'), z.boolean()]), MAX_PLAYBOOK_INPUTS).optional(),
  }),
]);

export const PlaybookCellSchema = CELL_MEMBERS;
export type PlaybookCell = z.output<typeof CELL_MEMBERS>;
export type PlaybookCellInput = z.input<typeof CELL_MEMBERS>;
export type PlaybookEdge = z.output<typeof EdgeSchema>;

export const PlaybookFlowSchema = z.strictObject({ cells: z.array(PlaybookCellSchema).max(MAX_PLAYBOOK_CELLS) });
export type PlaybookFlow = z.output<typeof PlaybookFlowSchema>;

const InputDeclarationSchema = z.strictObject({
  name: z.string().regex(FIELD_NAME, 'must be 1 to 64 letters, digits, underscores or dashes'),
  type: z.enum(PLAYBOOK_VALUE_TYPES),
  required: z.boolean().default(false),
  description: text(500).optional(),
  default: z.union([z.string().max(MAX_TEMPLATE_CHARS), z.number().refine(Number.isFinite, 'must be finite'), z.boolean()]).optional(),
});

const hasUniqueNames = (inputs: { name: string }[]): boolean => new Set(inputs.map((input) => input.name)).size === inputs.length;

export const PlaybookInputsSchema = z.array(InputDeclarationSchema).max(MAX_PLAYBOOK_INPUTS).refine(hasUniqueNames, 'input names are unique');
export type PlaybookInputDeclaration = z.output<typeof InputDeclarationSchema>;

export const PlaybookPolicySchema = z.strictObject({
  browserAutoGrant: z.boolean().default(false),
  autoDistill: z.boolean().default(false),
  maxRunsToKeep: z.int().min(1).max(MAX_RUNS_TO_KEEP).default(DEFAULT_MAX_RUNS_TO_KEEP),
});
export type PlaybookPolicy = z.output<typeof PlaybookPolicySchema>;

export const PlaybookNameSchema = text();
export const DEFAULT_PLAYBOOK_NAME = 'Untitled Playbook';

/** The cell kinds each field of the schema belongs to, for get_playbook_schema; zod stays the only judge of a cell. */
export const PLAYBOOK_CELL_FIELDS = {
  script: { required: ['program'], optional: ['args', 'env'] },
  http: { required: ['method', 'url'], optional: ['headers', 'body', 'auth'] },
  readFromStore: { required: ['storeID'], optional: ['columns', 'limit', 'whereColumnID', 'whereValue', 'sortColumnID', 'sortDescending'] },
  writeToStore: { required: ['storeID', 'rowMappings'], optional: ['naturalKeyColumnID'] },
  tool: { required: ['tool'], optional: ['input'] },
  manual: { required: ['prompt'], optional: [] },
  waitFor: { required: ['predicate'], optional: ['pollMs'] },
  subPlaybook: { required: ['playbookId'], optional: ['inputs'] },
} as const satisfies Record<PlaybookCellKind, { required: readonly string[]; optional: readonly string[] }>;

export const PLAYBOOK_CELL_COMMON_FIELDS = ['label', 'next', 'retry', 'timeoutSeconds', 'outputs'] as const;
