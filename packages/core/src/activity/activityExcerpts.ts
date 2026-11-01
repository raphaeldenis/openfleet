import { DAEMON_VERSION } from '../version.js';
import { maskedActivityText } from './activityMasking.js';
import { closedValuesOfKeyWord, ERROR_CODE_NAMES, IDENTIFIER_KEY_WORDS, isSafeToken, isUuid, type ParameterVocabulary } from './activityVocabulary.js';
import { UNKNOWN_FAILURE } from './refusalOutcome.js';

const MAX_KEPT_SCALAR_CHARS = 64;
const MAX_WALK_DEPTH = 4;
const MAX_WALK_ITEMS = 64;
const MAX_WALK_NODES = 256;
const MAX_PARSED_RESULT_CHARS = 256 * 1024;

const CUT_MARK = '[cut]';
const SECRET_MARK = '[secret]';
const UNSERIALIZABLE_MARK = '[unserializable]';

const KEPT_KEY = /^[A-Za-z]+(?:_[A-Za-z]+)*$/;
const ERROR_CLASS_NAME = /^(?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception)$/;

const SECRET_KEY_FRAGMENT = /token|secret|passw|pwd|credential|bearer|cookie|auth|api_?key|otp|private/i;
const SECRET_LAST_WORDS: ReadonlySet<string> = new Set(['key', 'keys', 'session', 'sessions', 'pin', 'pins', 'signature', 'signatures']);

interface KeyMeaning {
  isSecret: boolean;
  namesIdentifier: boolean;
  closedValues?: ReadonlySet<string>;
}

const NO_KEY: KeyMeaning = { isSecret: false, namesIdentifier: false };
const UNKNOWN_KEY: KeyMeaning = { isSecret: true, namesIdentifier: false };

const textMark = (text: string): string => `[text len=${text.length}]`;
const keyMark = (key: string): string => `[key len=${key.length}]`;

const lastWordOf = (key: string): string => key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_').at(-1) ?? '';

/** A kept string the masker would change looks like a credential: the secret mark stands for it. */
const keptOrSecretMark = (text: string): string => (maskedActivityText(text) === text ? text : SECRET_MARK);

/** The vocabulary and the budget of one excerpt. */
interface Walk {
  vocabulary: ParameterVocabulary;
  nodesLeft: number;
}

const isKnownKey = (key: string, walk: Walk): boolean => key.length <= MAX_KEPT_SCALAR_CHARS && KEPT_KEY.test(key) && walk.vocabulary.has(key);

/** Reads what a key says of its value; a key no registered tool names could itself be a secret, so its value counts as secret. */
const meaningOfKey = (key: string, walk: Walk): KeyMeaning => {
  if (!isKnownKey(key, walk)) return UNKNOWN_KEY;
  const lastWord = lastWordOf(key);
  const closedValues = closedValuesOfKeyWord(lastWord);
  return {
    isSecret: SECRET_KEY_FRAGMENT.test(key) || SECRET_LAST_WORDS.has(lastWord),
    namesIdentifier: IDENTIFIER_KEY_WORDS.has(lastWord),
    ...(closedValues === undefined ? {} : { closedValues }),
  };
};

const isKeptString = (text: string, key: KeyMeaning): boolean => {
  if (text.length > MAX_KEPT_SCALAR_CHARS) return false;
  const isIdentifierUnderItsKey = key.namesIdentifier && isSafeToken(text);
  const isMemberOfItsClosedSet = key.closedValues?.has(text) ?? false;
  return isUuid(text) || isIdentifierUnderItsKey || isMemberOfItsClosedSet;
};

const keptString = (text: string, key: KeyMeaning): string => (isKeptString(text, key) ? keptOrSecretMark(text) : textMark(text));

const keptKey = (key: string, walk: Walk): string => (isKnownKey(key, walk) ? keptOrSecretMark(key) : keyMark(key));

/** Two masked keys of the same length would overwrite each other: the second one onwards carries its index. */
const withoutCollisions = (keys: string[]): string[] => {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence === 1 ? key : `${key}#${occurrence}`;
  });
};

function keptValue(value: unknown, key: KeyMeaning, depth: number, walk: Walk): unknown {
  walk.nodesLeft -= 1;
  if (walk.nodesLeft < 0) return CUT_MARK;
  if (key.isSecret) return SECRET_MARK;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : textMark(String(value));
  if (typeof value === 'string') return keptString(value, key);
  if (typeof value !== 'object') return UNSERIALIZABLE_MARK;
  if (depth >= MAX_WALK_DEPTH) return CUT_MARK;
  return Array.isArray(value) ? keptArray(value, key, depth, walk) : keptObject(value, depth, walk);
}

function keptArray(items: unknown[], key: KeyMeaning, depth: number, walk: Walk): unknown[] {
  const kept = items.slice(0, MAX_WALK_ITEMS).map((item) => keptValue(item, key, depth + 1, walk));
  const isCut = items.length > MAX_WALK_ITEMS;
  return isCut ? [...kept, CUT_MARK] : kept;
}

function keptObject(value: object, depth: number, walk: Walk): Record<string, unknown> {
  const entries = Object.entries(value).slice(0, MAX_WALK_ITEMS);
  const keptKeys = withoutCollisions(entries.map(([key]) => keptKey(key, walk)));
  const keptEntries = entries.map(([key, entry], index) => [keptKeys[index]!, keptValue(entry, meaningOfKey(key, walk), depth + 1, walk)]);
  const isCut = Object.keys(value).length > MAX_WALK_ITEMS;
  return Object.fromEntries(isCut ? [...keptEntries, [CUT_MARK, CUT_MARK]] : keptEntries);
}

/**
 * Returns the JSON of the arguments with only what the Audit needs to read, under a key a registered tool names and that names no secret:
 * a number, a boolean, a UUID, an identifier under a key that names one (`note_id`, `ticket`), or a member of the closed set of its key (`status`, `model`, `code`),
 * each of at most 64 characters. Every other text stands as `[text len=N]`; a key no tool names stands as `[key len=N]` and hides its value,
 * like a secret key; past depth 4, 64 items or 256 values, `[cut]` stands for the rest.
 * Accepted limit: a secret shaped as a UUID, or as an identifier given under an identifier key, reads as the identifier it looks like.
 */
export function argumentsExcerpt(args: unknown, vocabulary: ParameterVocabulary): string {
  try {
    return JSON.stringify(keptValue(args, NO_KEY, 0, { vocabulary, nodesLeft: MAX_WALK_NODES })) ?? UNSERIALIZABLE_MARK;
  } catch {
    return UNSERIALIZABLE_MARK;
  }
}

const parsedJsonObjectOf = (text: string): Record<string, unknown> | undefined => {
  if (text.length > MAX_PARSED_RESULT_CHARS) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const isPlainObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    return isPlainObject ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const isKeptScalarField = ([key, value]: [string, unknown], walk: Walk): boolean => {
  const meaning = meaningOfKey(key, walk);
  if (meaning.isSecret) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return typeof value === 'string' && isKeptString(value, meaning) && keptOrSecretMark(value) === value;
};

/** Returns the size of the result, followed by its top-level scalar fields that pass the list of `argumentsExcerpt`; a field under an unknown key is left out, key included. */
export function resultExcerpt(resultText: string, vocabulary: ParameterVocabulary): string {
  const sizeMark = `[result len=${resultText.length}]`;
  const walk: Walk = { vocabulary, nodesLeft: MAX_WALK_NODES };
  const fields = Object.entries(parsedJsonObjectOf(resultText) ?? {}).slice(0, MAX_WALK_ITEMS);
  const keptFields = fields.filter((field) => isKeptScalarField(field, walk));
  return keptFields.length === 0 ? sizeMark : `${sizeMark} ${JSON.stringify(Object.fromEntries(keptFields))}`;
}

/** Returns a label that is a safe token of at most 64 characters as it is; any other text stands as its length. */
export function keptLabel(text: string): string {
  return isSafeToken(text) ? keptOrSecretMark(text) : textMark(text);
}

/** Returns a safe token or a UUID as it is; any other text stands as its length. Accepted limit: a secret shaped as an identifier reads as one. */
export function keptIdentifier(text: string): string {
  return isSafeToken(text) || isUuid(text) ? keptOrSecretMark(text) : textMark(text);
}

/** Returns an error code of the grammar, the name of an error class or the version of the daemon as it is; any other text stands as its length. */
export function keptDetail(text: string): string {
  const isErrorCode = ERROR_CODE_NAMES.has(text) || text === UNKNOWN_FAILURE;
  const isErrorClassName = text.length <= MAX_KEPT_SCALAR_CHARS && ERROR_CLASS_NAME.test(text);
  const isDaemonVersion = text === DAEMON_VERSION;
  if (isErrorCode || isDaemonVersion) return text;
  return isErrorClassName ? keptOrSecretMark(text) : textMark(text);
}
