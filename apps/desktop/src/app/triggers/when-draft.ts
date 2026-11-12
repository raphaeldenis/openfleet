import {
  TRIGGER_CRON_CATCH_UPS, TRIGGER_INTEGRATION_EVENTS, TRIGGER_ROW_COUNT_OPS, TRIGGER_SESSION_STATES, TRIGGER_STORE_EVENTS, TRIGGER_WHEN_SOURCES, DEFAULT_CRON_TIME_ZONE, TriggerWhenSchema,
  type TriggerWhen, type TriggerWhenSource,
} from '@openfleet/shared';

/** The fields of each WHEN source this screen can edit; a stored WHEN with any other field is shown, never rebuilt. */
export const WHEN_FIELDS: Readonly<Record<TriggerWhenSource, readonly string[]>> = {
  session_state: ['source', 'state', 'minutes'],
  silent_run: ['source', 'minutes'],
  data_store_query: ['source', 'storeId', 'event', 'op', 'value'],
  cron: ['source', 'expression', 'timezone', 'catchUp'],
  integration_records: ['source', 'itemId', 'event', 'field'],
};

export const WHEN_SOURCES = TRIGGER_WHEN_SOURCES;
export const SESSION_STATES = TRIGGER_SESSION_STATES;
export const STORE_EVENTS = TRIGGER_STORE_EVENTS;
export const ROW_COUNT_OPS = TRIGGER_ROW_COUNT_OPS;
export const INTEGRATION_EVENTS = TRIGGER_INTEGRATION_EVENTS;
export const CRON_CATCH_UPS = TRIGGER_CRON_CATCH_UPS;

/** Every parameter of every source as the form holds it: numbers stay text until the shared schema checks them. */
export interface WhenDraft {
  source: TriggerWhenSource;
  sessionState: (typeof SESSION_STATES)[number];
  minutes: string;
  storeId: string;
  storeEvent: (typeof STORE_EVENTS)[number];
  rowCountOp: (typeof ROW_COUNT_OPS)[number];
  rowCountThreshold: string;
  expression: string;
  timezone: string;
  catchUp: (typeof CRON_CATCH_UPS)[number];
  itemId: string;
  integrationEvent: (typeof INTEGRATION_EVENTS)[number];
  trackedField: string;
}

const EMPTY_WHEN_DRAFT: WhenDraft = {
  source: 'session_state', sessionState: 'idle', minutes: '', storeId: '', storeEvent: 'new_matching_rows', rowCountOp: 'eq', rowCountThreshold: '',
  expression: '', timezone: DEFAULT_CRON_TIME_ZONE, catchUp: 'skip', itemId: '', integrationEvent: 'new_record', trackedField: '',
};

const textOf = (value: number | undefined) => (value === undefined ? '' : String(value));

function draftFieldsOf(when: TriggerWhen): Partial<WhenDraft> {
  switch (when.source) {
    case 'session_state': return { sessionState: when.state, minutes: textOf(when.minutes) };
    case 'silent_run': return { minutes: textOf(when.minutes) };
    case 'data_store_query': return { storeId: when.storeId, storeEvent: when.event, rowCountOp: when.op ?? 'eq', rowCountThreshold: textOf(when.value) };
    case 'cron': return { expression: when.expression, timezone: when.timezone, catchUp: when.catchUp };
    case 'integration_records': return { itemId: when.itemId, integrationEvent: when.event, trackedField: when.field ?? '' };
  }
}

/** True when the stored WHEN is a source this screen knows, with only the fields it can rebuild. */
export function isEditableWhen(when: TriggerWhen): boolean {
  const knownFields = Object.hasOwn(WHEN_FIELDS, when.source) ? WHEN_FIELDS[when.source] : undefined;
  if (knownFields === undefined) return false;
  return Object.keys(when).every((name) => knownFields.includes(name));
}

/** The form of a stored WHEN, or nothing when this screen cannot rebuild it without losing a field. */
export function whenDraftOf(when: TriggerWhen): WhenDraft | undefined {
  if (!isEditableWhen(when)) return undefined;
  return { ...EMPTY_WHEN_DRAFT, source: when.source, ...draftFieldsOf(when) };
}

export const isSameWhenDraft = (left: WhenDraft, right: WhenDraft) => (Object.keys(left) as (keyof WhenDraft)[]).every((name) => left[name] === right[name]);

const numberOf = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));
const nonEmpty = (text: string): string | undefined => (text === '' ? undefined : text);

/** The WHEN the form describes, with only the parameters of the chosen source and event: what the shared schema then accepts or refuses. */
function candidateOf(draft: WhenDraft): unknown {
  switch (draft.source) {
    case 'session_state': {
      const waitsForMinutes = draft.sessionState !== 'closed_with_error';
      return { source: 'session_state', state: draft.sessionState, ...(waitsForMinutes && { minutes: numberOf(draft.minutes) }) };
    }
    case 'silent_run': return { source: 'silent_run', minutes: numberOf(draft.minutes) };
    case 'data_store_query': {
      const isRowCount = draft.storeEvent === 'row_count';
      return { source: 'data_store_query', storeId: draft.storeId, event: draft.storeEvent, ...(isRowCount && { op: draft.rowCountOp, value: numberOf(draft.rowCountThreshold) }) };
    }
    case 'cron': return { source: 'cron', expression: draft.expression, timezone: draft.timezone, catchUp: draft.catchUp };
    case 'integration_records': {
      const tracksAField = draft.integrationEvent === 'field_changed';
      return { source: 'integration_records', itemId: draft.itemId, event: draft.integrationEvent, ...(tracksAField && { field: nonEmpty(draft.trackedField) }) };
    }
  }
}

type Issue = { path: PropertyKey[]; message: string; errors?: Issue[][] };

/** A refused union names every member that failed; the one that matters is the member whose source the form chose, so it is the one without an issue on `source`. */
function firstIssueOfChosenSource(issue: Issue): Issue {
  const refusalsByMember = issue.errors ?? [];
  const refusalOfChosenSource = refusalsByMember.find((refusals) => refusals.every((refusal) => refusal.path[0] !== 'source'));
  return refusalOfChosenSource?.[0] ?? issue;
}

/** The WHEN as the shared schema reads the form, or the first thing it refuses. */
export function whenOrProblemOf(draft: WhenDraft): { when: TriggerWhen } | { problem: string } {
  const parsed = TriggerWhenSchema.safeParse(candidateOf(draft));
  if (parsed.success) return { when: parsed.data };
  const issue = firstIssueOfChosenSource(parsed.error.issues[0] as Issue);
  const place = issue.path.length === 0 ? '' : ` · ${issue.path.join('.')}`;
  return { problem: `Quand${place} : ${issue.message}` };
}
