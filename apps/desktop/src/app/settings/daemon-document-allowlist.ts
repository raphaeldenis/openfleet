import { DEGRADED_CODES, HARNESSES, SESSION_CLOSE_REASONS, SESSION_STATES, TEAM_MODEL_RUNGS, type DiagnosticsDocument } from '@openfleet/shared';

/** What a field becomes when its value does not have the shape the allowlist expects. */
export const UNRECOGNISED = 'unrecognised';
export const OTHER_MODEL_FAMILY = 'other';
export const OPENFLEET_HOME_ALIAS = '$OPENFLEET_HOME';

/** Turns a daemon value into a typed one; `undefined` leaves the field out of the bundle. */
export type FieldRule = (value: unknown) => unknown;

export interface ListEntry<Item> { eachItem: AllowlistEntry<Item> }

/** The allowlist of a value: a rule for a leaf, a list entry for an array, a shape for an object. */
export type AllowlistEntry<Value> = Value extends readonly (infer Item)[]
  ? unknown extends Item ? FieldRule : ListEntry<Item>
  : Value extends object ? AllowlistShape<Value> : FieldRule;

/** Names every key of `Value`, optional ones included, so a field the daemon adds fails the type check until the table lists it. */
export type AllowlistShape<Value> = { [Key in keyof Value]-?: AllowlistEntry<NonNullable<Value[Key]>> };

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DAEMON_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9a-z.]{1,24})?$/;
const NODE_VERSION = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const REFERENCE = /^[0-9a-f]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIGRATION_ID = /^\d{3}_[a-z0-9_]{1,64}$/;
const NODE_PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'] as const;
const HEALTH_STATUSES = ['ok', 'degraded'] as const;
const HEALTHY_QUICK_CHECK = 'ok';
const FAILED_QUICK_CHECK = 'failed';
const HIGHEST_PORT = 65_535;

const matching = (pattern: RegExp): FieldRule => (value) => (typeof value === 'string' && pattern.test(value) ? value : UNRECOGNISED);
const oneOf = (names: readonly string[]): FieldRule => (value) => (typeof value === 'string' && names.includes(value) ? value : UNRECOGNISED);
const flag: FieldRule = (value) => (typeof value === 'boolean' ? value : UNRECOGNISED);
const integer: FieldRule = (value) => (Number.isSafeInteger(value) ? value : UNRECOGNISED);
const count: FieldRule = (value) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value : UNRECOGNISED);
const port: FieldRule = (value) => (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= HIGHEST_PORT ? value : UNRECOGNISED);
const quickCheck: FieldRule = (value) => (value === HEALTHY_QUICK_CHECK ? HEALTHY_QUICK_CHECK : FAILED_QUICK_CHECK);
const droppedFreeText: FieldRule = () => undefined;
const projectedByTheDesktop: FieldRule = () => undefined;

const modelFamily: FieldRule = (value) => {
  if (typeof value !== 'string') return UNRECOGNISED;
  const lowerCaseModel = value.toLowerCase();
  return TEAM_MODEL_RUNGS.find((rung) => lowerCaseModel.includes(rung)) ?? OTHER_MODEL_FAMILY;
};

/**
 * Every field of the daemon's diagnostics document and the typed value the bundle keeps of it.
 * Free text is dropped, never masked; `log` is replaced by the desktop's projection of each record.
 */
export const DAEMON_DOCUMENT_ALLOWLIST = {
  generatedAt: matching(ISO_TIMESTAMP),
  version: { openfleet: matching(DAEMON_VERSION), node: matching(NODE_VERSION), platform: oneOf(NODE_PLATFORMS) },
  config: { port, home: oneOf([OPENFLEET_HOME_ALIAS]), e2eEnabled: flag },
  health: {
    status: oneOf(HEALTH_STATUSES),
    issues: { eachItem: { code: oneOf(DEGRADED_CODES), since: matching(ISO_TIMESTAMP), message: droppedFreeText, id: matching(REFERENCE), count } },
  },
  migrations: { eachItem: { id: matching(MIGRATION_ID), appliedAt: matching(ISO_TIMESTAMP) } },
  db: { quickCheck, sizeBytes: count },
  sessions: {
    eachItem: {
      id: matching(UUID),
      name: droppedFreeText,
      state: oneOf(SESSION_STATES),
      harness: oneOf(HARNESSES),
      model: modelFamily,
      parentId: matching(UUID),
      exitCode: integer,
      reason: oneOf(SESSION_CLOSE_REASONS),
      closedAt: matching(ISO_TIMESTAMP),
      directory: droppedFreeText,
    },
  },
  log: projectedByTheDesktop,
} satisfies AllowlistShape<DiagnosticsDocument>;

type AnyEntry = FieldRule | { eachItem: AnyEntry } | { [key: string]: AnyEntry };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isListEntry = (entry: AnyEntry): entry is { eachItem: AnyEntry } => typeof entry === 'object' && 'eachItem' in entry;

function projectedBy(entry: AnyEntry, value: unknown): unknown {
  if (typeof entry === 'function') return entry(value);
  if (isListEntry(entry)) return Array.isArray(value) ? value.map((item) => projectedBy(entry.eachItem, item)) : [];
  const source = isRecord(value) ? value : {};
  const presentKeys = Object.keys(entry).filter((key) => Object.hasOwn(source, key));
  const projectedEntries = presentKeys.map((key) => [key, projectedBy(entry[key]!, source[key])] as const);
  return Object.fromEntries(projectedEntries.filter(([, projected]) => projected !== undefined));
}

/** Keeps the fields the allowlist names, each reduced to its typed value; any other field, `log` included, is left out. */
export function allowlistedDaemonDocument(document: unknown): Record<string, unknown> {
  return projectedBy(DAEMON_DOCUMENT_ALLOWLIST as AnyEntry, document) as Record<string, unknown>;
}
