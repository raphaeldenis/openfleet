import { escapedControlsDeep, escapedControlsOf } from '@openfleet/shared';
import type { TriggerView } from '../core/playbook-trigger-views';

/** A text longer than this many characters is cut on screen until the human asks to read it all. */
export const PREVIEW_MAX_CHARS = 400;

const NOT_SET = 'non défini';
const EMPTY_TEXT = '(texte vide)';

const WHEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  session_state: ['source', 'state', 'minutes'],
  silent_run: ['source', 'minutes'],
  data_store_query: ['source', 'storeId', 'event', 'op', 'value'],
  cron: ['source', 'expression', 'timezone', 'catchUp'],
  integration_records: ['source', 'integrationId', 'event', 'keyPrefix', 'statuses'],
};

const RUN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  prompt_manager: ['kind', 'managerId', 'prompt'],
  notify: ['kind', 'title', 'message'],
  prompt_session: ['kind', 'sessionId', 'prompt'],
  close_session: ['kind', 'sessionId'],
  run_playbook: ['kind', 'playbookId', 'inputs'],
};

const POLICY_FIELDS = ['cooldownSeconds', 'maxFiresPerDay', 'batchMode', 'backlogPolicy', 'backlogMaxAgeMinutes'] as const;
const CONDITION_FIELDS = ['id', 'lhs', 'op', 'rhs', 'join', 'caseInsensitive'] as const;

export interface ReviewField {
  key: string;
  label: string;
  text: string;
}

/** What the digest covers, as lines of plain text, and the places of the rule this screen cannot show. */
export interface ApprovalReview {
  fields: ReviewField[];
  unreadable: string[];
}

const mergedReviews = (reviews: ApprovalReview[]): ApprovalReview => ({
  fields: reviews.flatMap((review) => review.fields),
  unreadable: reviews.flatMap((review) => review.unreadable),
});

const knownFieldsOf = (table: Readonly<Record<string, readonly string[]>>, name: unknown): readonly string[] | undefined =>
  typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : undefined;

/** The value as plain text with control and direction characters written as their code, or undefined when it has no text form. */
function plainTextOf(value: unknown): string | undefined {
  if (value === undefined) return NOT_SET;
  if (typeof value === 'string') return value === '' ? EMPTY_TEXT : escapedControlsOf(value);
  const isScalar = value === null || typeof value === 'number' || typeof value === 'boolean';
  if (isScalar) return String(value);
  if (typeof value !== 'object') return undefined;
  try {
    return JSON.stringify(escapedControlsDeep(value), null, 2);
  } catch {
    return undefined;
  }
}

/** One line per known field, and every other field of the record named as unreadable. */
function recordReview({ keyPrefix, labelPrefix, record, knownFields }: { keyPrefix: string; labelPrefix: string; record: object; knownFields: readonly string[] }): ApprovalReview {
  const values = record as Record<string, unknown>;
  const lines = knownFields.map((name) => ({ key: `${keyPrefix}.${name}`, label: `${labelPrefix} · ${name}`, text: plainTextOf(values[name]) }));
  const unknownNames = Object.keys(values).filter((name) => !knownFields.includes(name));
  const fields = lines.filter((line): line is ReviewField => line.text !== undefined);
  const unreadableLines = lines.filter((line) => line.text === undefined).map((line) => line.label);
  return { fields, unreadable: [...unreadableLines, ...unknownNames.map((name) => `${labelPrefix} · ${escapedControlsOf(name)}`)] };
}

function ownerReview({ ownerManagerId }: TriggerView): ApprovalReview {
  const text = ownerManagerId === null ? 'Aucun manager' : escapedControlsOf(ownerManagerId);
  return { fields: [{ key: 'owner', label: 'Propriétaire', text }], unreadable: [] };
}

/** A section whose kind decides which fields it has; a kind this screen does not know is unreadable as a whole. */
function sectionReview({ keyPrefix, labelPrefix, discriminator, section, fieldsByKind }: {
  keyPrefix: string; labelPrefix: string; discriminator: 'source' | 'kind'; section: object; fieldsByKind: Readonly<Record<string, readonly string[]>>;
}): ApprovalReview {
  const kind = (section as Record<string, unknown>)[discriminator];
  const knownFields = knownFieldsOf(fieldsByKind, kind);
  if (knownFields === undefined) return { fields: [], unreadable: [`${labelPrefix} · ${discriminator} « ${escapedControlsOf(String(kind))} »`] };
  return recordReview({ keyPrefix, labelPrefix, record: section, knownFields });
}

function conditionReview(condition: TriggerView['conditions'][number], position: number): ApprovalReview {
  const label = `Condition ${position + 1}`;
  const unknownNames = Object.keys(condition).filter((name) => !(CONDITION_FIELDS as readonly string[]).includes(name));
  const unreadable = unknownNames.map((name) => `${label} · ${escapedControlsOf(name)}`);
  const valueText = condition.rhs === undefined ? '' : ` ${JSON.stringify(escapedControlsDeep(condition.rhs))}`;
  const ignoresCase = condition.caseInsensitive ? 'oui' : 'non';
  const text = `${condition.join} · ${escapedControlsOf(condition.lhs)} ${condition.op}${valueText} · casse ignorée : ${ignoresCase} · id ${escapedControlsOf(condition.id)}`;
  return { fields: [{ key: `condition.${position}`, label, text }], unreadable };
}

function conditionsReview({ conditions }: TriggerView): ApprovalReview {
  if (conditions.length === 0) return { fields: [{ key: 'conditions', label: 'Conditions', text: 'Aucune' }], unreadable: [] };
  return mergedReviews(conditions.map(conditionReview));
}

/** Every line of the approved graph that the digest covers, in the order the human reads the rule. */
export function approvalReviewOf(trigger: TriggerView): ApprovalReview {
  return mergedReviews([
    ownerReview(trigger),
    sectionReview({ keyPrefix: 'when', labelPrefix: 'Quand', discriminator: 'source', section: trigger.when, fieldsByKind: WHEN_FIELDS }),
    conditionsReview(trigger),
    sectionReview({ keyPrefix: 'run', labelPrefix: 'Alors', discriminator: 'kind', section: trigger.run, fieldsByKind: RUN_FIELDS }),
    recordReview({ keyPrefix: 'policy', labelPrefix: 'Politique', record: trigger.policy, knownFields: POLICY_FIELDS }),
  ]);
}

/** The first characters of a text and how many are left out; nothing is left out of a short text. */
export function previewOf(text: string): { shownText: string; hiddenChars: number } {
  const characters = Array.from(text);
  const isShort = characters.length <= PREVIEW_MAX_CHARS;
  if (isShort) return { shownText: text, hiddenChars: 0 };
  return { shownText: characters.slice(0, PREVIEW_MAX_CHARS).join(''), hiddenChars: characters.length - PREVIEW_MAX_CHARS };
}
