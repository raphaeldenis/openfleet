import {
  EVENT_PREFIXES_BY_SOURCE, MAX_TRIGGER_CONDITIONS, TRIGGER_CONDITION_JOINS, TRIGGER_CONDITION_OPERATORS, TriggerConditionInputSchema,
  type TriggerCondition, type TriggerConditionOperator, type TriggerWhenSource,
} from '@openfleet/shared';

export const CONDITION_JOINS = TRIGGER_CONDITION_JOINS;
export const CONDITION_OPERATORS = TRIGGER_CONDITION_OPERATORS;
export const CONDITION_LIMIT = MAX_TRIGGER_CONDITIONS;

/** The fields of a condition this screen can rebuild; a stored condition with any other field is shown, never rebuilt. */
const KNOWN_CONDITION_FIELDS = ['id', 'lhs', 'op', 'rhs', 'join', 'caseInsensitive'];

const OPERATORS_WITHOUT_VALUE: readonly TriggerConditionOperator[] = ['exists', 'not_exists'];

export type ValueKind = 'text' | 'number' | 'boolean';
export const VALUE_KINDS: readonly ValueKind[] = ['text', 'number', 'boolean'];

/** A condition the form can rebuild: the numbers stay text until the shared schema checks them. */
export interface EditableConditionDraft {
  kind: 'editable';
  key: string;
  /** The id the daemon gave the condition; a condition added in the form has none yet. */
  storedId: string | undefined;
  join: (typeof CONDITION_JOINS)[number];
  /** The namespace of the event the path reads, such as `event.row.`. */
  namespace: string;
  path: string;
  op: TriggerConditionOperator;
  valueKind: ValueKind;
  valueText: string;
  caseInsensitive: boolean;
}

/** A stored condition this screen cannot rebuild without losing something: it keeps its place and goes back as stored. */
export interface OpaqueConditionDraft {
  kind: 'opaque';
  key: string;
  stored: TriggerCondition;
}

export type ConditionDraft = EditableConditionDraft | OpaqueConditionDraft;
export type ConditionChange = Partial<Omit<EditableConditionDraft, 'kind' | 'key' | 'storedId'>>;

export const namespacesOf = (source: TriggerWhenSource | undefined): readonly string[] =>
  (source !== undefined && Object.hasOwn(EVENT_PREFIXES_BY_SOURCE, source) ? EVENT_PREFIXES_BY_SOURCE[source] : []);

/** The namespace the condition reads under the given source: the one it holds when the source offers it, else the first the source offers. */
export function effectiveNamespaceOf({ condition, source }: { condition: EditableConditionDraft; source: TriggerWhenSource | undefined }): string {
  const offered = namespacesOf(source);
  return offered.includes(condition.namespace) ? condition.namespace : (offered[0] ?? condition.namespace);
}

export const needsValue = (op: TriggerConditionOperator): boolean => !OPERATORS_WITHOUT_VALUE.includes(op);
export const canAddCondition = (conditions: readonly ConditionDraft[]): boolean => conditions.length < CONDITION_LIMIT;

function valueOfStored(rhs: TriggerCondition['rhs']): { valueKind: ValueKind; valueText: string } {
  if (typeof rhs === 'number') return { valueKind: 'number', valueText: String(rhs) };
  if (typeof rhs === 'boolean') return { valueKind: 'boolean', valueText: String(rhs) };
  return { valueKind: 'text', valueText: rhs ?? '' };
}

function conditionDraftOf({ condition, source }: { condition: TriggerCondition; source: TriggerWhenSource }): ConditionDraft {
  const namespace = namespacesOf(source).find((offered) => condition.lhs.startsWith(offered));
  const hasOnlyKnownFields = Object.keys(condition).every((name) => KNOWN_CONDITION_FIELDS.includes(name));
  const rhsType = typeof condition.rhs;
  const hasReadableValue = condition.rhs === undefined || ['string', 'number', 'boolean'].includes(rhsType);
  const isRebuildable = namespace !== undefined && hasOnlyKnownFields && hasReadableValue;
  if (!isRebuildable) return { kind: 'opaque', key: condition.id, stored: condition };
  return {
    kind: 'editable', key: condition.id, storedId: condition.id, join: condition.join, namespace, path: condition.lhs.slice(namespace.length),
    op: condition.op, ...valueOfStored(condition.rhs), caseInsensitive: condition.caseInsensitive,
  };
}

export const conditionDraftsOf = ({ conditions, source }: { conditions: TriggerCondition[]; source: TriggerWhenSource }): ConditionDraft[] =>
  conditions.map((condition) => conditionDraftOf({ condition, source }));

export function newConditionDraft({ key, source }: { key: string; source: TriggerWhenSource | undefined }): EditableConditionDraft {
  return { kind: 'editable', key, storedId: undefined, join: 'and', namespace: namespacesOf(source)[0] ?? '', path: '', op: 'eq', valueKind: 'text', valueText: '', caseInsensitive: false };
}

export function withConditionAdded({ conditions, key, source }: { conditions: ConditionDraft[]; key: string; source: TriggerWhenSource | undefined }): ConditionDraft[] {
  return canAddCondition(conditions) ? [...conditions, newConditionDraft({ key, source })] : conditions;
}

export const withConditionRemoved = ({ conditions, key }: { conditions: ConditionDraft[]; key: string }): ConditionDraft[] =>
  conditions.filter((condition) => condition.key !== key || condition.kind === 'opaque');

export const withConditionChanged = ({ conditions, key, change }: { conditions: ConditionDraft[]; key: string; change: ConditionChange }): ConditionDraft[] =>
  conditions.map((condition) => (condition.key === key && condition.kind === 'editable' ? { ...condition, ...change } : condition));

const numberOf = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

function valueToSend(condition: EditableConditionDraft): { rhs?: string | number | boolean } {
  if (!needsValue(condition.op)) return {};
  if (condition.valueKind === 'boolean') return { rhs: condition.valueText === 'true' };
  if (condition.valueKind === 'number') return { rhs: numberOf(condition.valueText) };
  return { rhs: condition.valueText };
}

/** What the form says one condition is, as the shared schema reads a condition a caller writes; the first condition always joins with `and`. */
function conditionToSend({ condition, position, source }: { condition: ConditionDraft; position: number; source: TriggerWhenSource | undefined }): Record<string, unknown> {
  if (condition.kind === 'opaque') return condition.stored;
  const isFirst = position === 0;
  const idField = condition.storedId === undefined ? {} : { id: condition.storedId };
  return {
    ...idField, join: isFirst ? 'and' : condition.join, lhs: `${effectiveNamespaceOf({ condition, source })}${condition.path}`, op: condition.op,
    ...valueToSend(condition), caseInsensitive: condition.caseInsensitive,
  };
}

const conditionsToSend = ({ conditions, source }: { conditions: readonly ConditionDraft[]; source: TriggerWhenSource | undefined }) =>
  conditions.map((condition, position) => conditionToSend({ condition, position, source }));

/** The first thing the shared schema refuses in the conditions, or nothing. */
export function problemOfConditions({ conditions, source }: { conditions: readonly ConditionDraft[]; source: TriggerWhenSource | undefined }): string | undefined {
  const toSend = conditionsToSend({ conditions, source });
  for (const [position, condition] of conditions.entries()) {
    if (condition.kind === 'opaque') continue;
    const { id: _daemonOwnedId, ...conditionAsCallerWritesIt } = toSend[position]!;
    const parsed = TriggerConditionInputSchema.safeParse(conditionAsCallerWritesIt);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0]!;
    const place = issue.path.length === 0 ? '' : ` · ${issue.path.join('.')}`;
    return `Condition ${position + 1}${place} : ${issue.message}`;
  }
  return undefined;
}

/** The conditions a save sends, or nothing when they read the same as when the form was opened (under the source it was opened with). */
export function changedConditionsOf({ conditions, openedWith, source, openedSource }: {
  conditions: readonly ConditionDraft[]; openedWith: readonly ConditionDraft[]; source: TriggerWhenSource | undefined; openedSource: TriggerWhenSource | undefined;
}): { conditions: Record<string, unknown>[] } | Record<string, never> {
  const toSend = conditionsToSend({ conditions, source });
  const sentWhenOpened = conditionsToSend({ conditions: openedWith, source: openedSource });
  const isUnchanged = JSON.stringify(toSend) === JSON.stringify(sentWhenOpened);
  return isUnchanged ? {} : { conditions: toSend };
}
