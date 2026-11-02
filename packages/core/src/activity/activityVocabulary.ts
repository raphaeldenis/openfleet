import {
  ACTIVITY_OUTCOMES, ARBITER_MODELS, ARBITER_ROLE, ASK_USER_GATES, ERROR_CODES, ERROR_KINDS, ESCALATION_STATUSES, HARNESSES, LAW_STATUSES, MANAGER_LOG_KINDS,
  MANAGER_MODES, MANAGER_ROLE, PERMISSION_MODES, PROPOSAL_KINDS, PROPOSAL_STATUSES, REOPEN_MODES, ROW_CHANGE_KINDS, SESSION_READINESS, SESSION_STATES,
  PLAYBOOK_CELL_KINDS, PROMPT_MANAGER_ALIAS, SHIP_VERDICTS, STEP_FINDING_SEVERITIES, TODO_STATUSES, TRIGGER_BACKLOG_POLICIES, TRIGGER_BATCH_MODES, TRIGGER_CONDITION_JOINS, TRIGGER_CONDITION_OPERATORS,
  TRIGGER_INTEGRATION_EVENTS, TRIGGER_LEDGER_STATES, TRIGGER_RUN_KINDS, TRIGGER_SESSION_STATES, TRIGGER_STORE_EVENTS, TRIGGER_WHEN_SOURCES, WRAP_MODES,
} from '@openfleet/shared';
import type { Decision } from '../governance/governanceQueueService.js';
import type { FindingSeverity } from '../review/reviewFindingsRepository.js';
import { TOOL_CATEGORIES } from '../mcp/toolCatalog.js';
import { DEFAULT_MODEL_TABLE, KNOWN_MODELS } from '../models.js';

const MAX_SAFE_TOKEN_CHARS = 64;
const MAX_SCHEMA_DEPTH = 12;

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSafeToken = (text: string): boolean => text.length <= MAX_SAFE_TOKEN_CHARS && SAFE_TOKEN.test(text);
export const isUuid = (text: string): boolean => UUID.test(text);

export const ERROR_CODE_NAMES: ReadonlySet<string> = new Set(Object.keys(ERROR_CODES));

// The columns of a manager board are select options a project names itself: these are the names its boards use.
const BOARD_ROW_STATUSES = ['backlog', 'todo', 'open', 'doing', 'in_progress', 'review', 'in_review', 'qa', 'blocked', 'done', 'closed'] as const;
const REVIEWER_ROLE = 'reviewer';
const DECISIONS = ['approve', 'deny'] as const satisfies readonly Decision['decision'][];
const FINDING_SEVERITIES = ['go', 'no-go', 'clean'] as const satisfies readonly FindingSeverity[];

const closedSet = (...lists: readonly (readonly string[])[]): ReadonlySet<string> => new Set(lists.flat());

/** The closed set of values kept under a key, by the last word of the key. */
const VALUES_BY_KEY_WORD: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['status', closedSet(BOARD_ROW_STATUSES, TODO_STATUSES, PROPOSAL_STATUSES, LAW_STATUSES, ESCALATION_STATUSES, SESSION_STATES, SESSION_READINESS)],
  ['kind', closedSet(PROPOSAL_KINDS, MANAGER_LOG_KINDS, ROW_CHANGE_KINDS, ERROR_KINDS, TRIGGER_WHEN_SOURCES, TRIGGER_RUN_KINDS, [PROMPT_MANAGER_ALIAS], PLAYBOOK_CELL_KINDS)],
  ['source', closedSet(TRIGGER_WHEN_SOURCES)],
  ['state', closedSet(TRIGGER_LEDGER_STATES, TRIGGER_SESSION_STATES)],
  ['event', closedSet(TRIGGER_STORE_EVENTS, TRIGGER_INTEGRATION_EVENTS)],
  ['op', closedSet(TRIGGER_CONDITION_OPERATORS)],
  ['join', closedSet(TRIGGER_CONDITION_JOINS)],
  ['policy', closedSet(TRIGGER_BACKLOG_POLICIES)],
  ['category', closedSet(TOOL_CATEGORIES)],
  ['outcome', closedSet(ACTIVITY_OUTCOMES)],
  ['role', closedSet([MANAGER_ROLE, REVIEWER_ROLE, ARBITER_ROLE])],
  ['harness', closedSet(HARNESSES)],
  ['model', closedSet(KNOWN_MODELS, Object.keys(DEFAULT_MODEL_TABLE), ARBITER_MODELS)],
  ['mode', closedSet(PERMISSION_MODES, MANAGER_MODES, REOPEN_MODES, WRAP_MODES, ASK_USER_GATES, TRIGGER_BATCH_MODES)],
  ['decision', closedSet(DECISIONS)],
  ['verdict', closedSet(SHIP_VERDICTS)],
  ['severity', closedSet(STEP_FINDING_SEVERITIES, FINDING_SEVERITIES)],
  ['code', ERROR_CODE_NAMES],
]);

export const IDENTIFIER_KEY_WORDS: ReadonlySet<string> = new Set(['id', 'ids', 'ticket', 'tickets', 'ref', 'refs', 'note', 'store', 'project', 'playbook', 'manager', 'parent', 'target', 'trigger', 'run', 'playbook']);

export const closedValuesOfKeyWord = (keyWord: string): ReadonlySet<string> | undefined => VALUES_BY_KEY_WORD.get(keyWord);

// The scalar fields the tools answer that the Audit reads: ids, revisions and counts.
const KNOWN_RESULT_FIELDS = [
  'rev', 'revision', 'expected_rev', 'content_rev', 'armed', 'count', 'total', 'inserted', 'updated', 'deleted', 'created', 'ok', 'seq',
  'note_id', 'store_id', 'row_id', 'session_id', 'manager_id', 'project_id', 'proposal_id', 'law_id', 'escalation_id', 'batch_id', 'report_id',
];

type SchemaDefinition = Record<string, unknown> & { type?: string };

const definitionOf = (schema: unknown): SchemaDefinition | undefined => (schema as { _zod?: { def?: SchemaDefinition } } | undefined)?._zod?.def;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The schemas a definition wraps: the inner type of an optional, the element of an array, the options of a union, the value of a record. */
const childSchemasOf = (definition: SchemaDefinition): unknown[] => {
  if (definition.type === 'lazy') return [(definition.getter as () => unknown)()];
  const singleChildren = [definition.innerType, definition.element, definition.left, definition.right, definition.in, definition.out, definition.valueType];
  const listedChildren = [definition.options, definition.items].filter(Array.isArray).flat();
  return [...singleChildren, ...listedChildren].filter((child) => child !== undefined);
};

function collectParameterNames(schema: unknown, names: Set<string>, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) return;
  const definition = definitionOf(schema);
  const shape = definition === undefined ? schema : definition.shape;
  const isShape = definition?.type === 'object' || (definition === undefined && isPlainObject(schema));
  if (isShape && isPlainObject(shape)) {
    for (const [name, child] of Object.entries(shape)) {
      names.add(name);
      collectParameterNames(child, names, depth + 1);
    }
    return;
  }
  if (definition === undefined) return;
  for (const child of childSchemasOf(definition)) collectParameterNames(child, names, depth + 1);
}

/**
 * The closed set of keys the activity log keeps: the parameter names of the registered tools, top-level and nested,
 * the result fields the Audit reads and the identifier and enumeration words. Each tool is read once, at its first registration.
 */
export class ParameterVocabulary {
  private readonly names = new Set<string>([...KNOWN_RESULT_FIELDS, ...IDENTIFIER_KEY_WORDS, ...VALUES_BY_KEY_WORD.keys()]);
  private readonly toolsRead = new Set<string>();

  has(key: string): boolean {
    return this.names.has(key);
  }

  learnToolSchema(toolName: string, inputSchema: unknown): void {
    if (this.toolsRead.has(toolName)) return;
    this.toolsRead.add(toolName);
    collectParameterNames(inputSchema, this.names, 0);
  }
}
