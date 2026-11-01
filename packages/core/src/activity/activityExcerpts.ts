import { createHash } from 'node:crypto';
import { maskedActivityText } from './activityMasking.js';

const MAX_KEPT_SCALAR_CHARS = 64;
const MAX_WALK_DEPTH = 4;
const MAX_WALK_ITEMS = 64;
const MAX_WALK_NODES = 256;
const MAX_PARSED_RESULT_CHARS = 256 * 1024;
const FINGERPRINT_HEX_CHARS = 8;

const CUT_MARK = '[cut]';
const SECRET_MARK = '[secret]';
const UNSERIALIZABLE_MARK = '[unserializable]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ENUMERATION_MEMBER = /^[a-z][a-z0-9._-]*$/;
const KEPT_KEY = /^[A-Za-z]+(?:_[A-Za-z]+)*$/;

const SECRET_KEY_FRAGMENT = /token|secret|passw|pwd|credential|bearer|cookie|auth|api_?key|otp|private/i;
const SECRET_LAST_WORDS: ReadonlySet<string> = new Set(['key', 'keys', 'session', 'sessions', 'pin', 'pins', 'signature', 'signatures']);
const IDENTIFIER_LAST_WORDS: ReadonlySet<string> = new Set(['id', 'ids', 'ticket', 'tickets', 'ref', 'refs', 'note', 'store', 'project', 'manager', 'parent', 'target']);
const ENUMERATION_LAST_WORDS: ReadonlySet<string> = new Set(['status', 'kind', 'category', 'outcome', 'role', 'harness', 'model', 'mode', 'decision', 'verdict', 'severity']);

interface KeyMeaning {
  isSecret: boolean;
  namesIdentifier: boolean;
  namesEnumerationMember: boolean;
}

const NO_KEY: KeyMeaning = { isSecret: false, namesIdentifier: false, namesEnumerationMember: false };
const UNREADABLE_KEY: KeyMeaning = { isSecret: true, namesIdentifier: false, namesEnumerationMember: false };

const fingerprintOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
const textMark = (text: string): string => `[text len=${text.length} sha=${fingerprintOf(text)}]`;
const keyMark = (key: string): string => `[key len=${key.length} sha=${fingerprintOf(key)}]`;

const isReadableKey = (key: string): boolean => key.length <= MAX_KEPT_SCALAR_CHARS && KEPT_KEY.test(key);

const lastWordOf = (key: string): string => key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_').at(-1) ?? '';

/** Reads what a key says of its value; a key that is not plain letters and underscores could hide a secret word, so its value counts as secret. */
const meaningOfKey = (key: string): KeyMeaning => {
  if (!isReadableKey(key)) return UNREADABLE_KEY;
  const lastWord = lastWordOf(key);
  return {
    isSecret: SECRET_KEY_FRAGMENT.test(key) || SECRET_LAST_WORDS.has(lastWord),
    namesIdentifier: IDENTIFIER_LAST_WORDS.has(lastWord),
    namesEnumerationMember: ENUMERATION_LAST_WORDS.has(lastWord),
  };
};

const isKeptString = (text: string, key: KeyMeaning): boolean => {
  if (text.length > MAX_KEPT_SCALAR_CHARS) return false;
  const isIdentifierUnderItsKey = key.namesIdentifier && IDENTIFIER.test(text);
  const isMemberUnderItsKey = key.namesEnumerationMember && ENUMERATION_MEMBER.test(text);
  return UUID.test(text) || isIdentifierUnderItsKey || isMemberUnderItsKey;
};

/** A kept string the masker would change looks like a credential: the secret mark stands for it. */
const keptOrSecretMark = (text: string): string => (maskedActivityText(text) === text ? text : SECRET_MARK);

const keptString = (text: string, key: KeyMeaning): string => (isKeptString(text, key) ? keptOrSecretMark(text) : textMark(text));

const keptKey = (key: string): string => (isReadableKey(key) ? keptOrSecretMark(key) : keyMark(key));

interface Walk {
  nodesLeft: number;
}

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
  const entries = Object.entries(value);
  const kept = entries.slice(0, MAX_WALK_ITEMS).map(([key, entry]) => [keptKey(key), keptValue(entry, meaningOfKey(key), depth + 1, walk)]);
  const isCut = entries.length > MAX_WALK_ITEMS;
  return Object.fromEntries(isCut ? [...kept, [CUT_MARK, CUT_MARK]] : kept);
}

/**
 * Returns the JSON of the arguments with only what the Audit needs to read: a number, a boolean, a UUID,
 * an identifier under a key that names one (`note_id`, `ticket`), or a member of an enumeration under its key (`status`, `model`),
 * each of at most 64 characters and under a key that names no secret. Every other text stands as `[text len=N sha=<8 hex>]`;
 * a secret key hides its whole value; past depth 4, 64 items or 256 values, `[cut]` stands for the rest.
 * Known limit: a secret shaped as a UUID, or as an identifier given under an identifier key, reads as the identifier it looks like.
 */
export function argumentsExcerpt(args: unknown): string {
  try {
    return JSON.stringify(keptValue(args, NO_KEY, 0, { nodesLeft: MAX_WALK_NODES })) ?? UNSERIALIZABLE_MARK;
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

const isKeptScalarField = ([key, value]: [string, unknown]): boolean => {
  const meaning = meaningOfKey(key);
  if (meaning.isSecret) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return typeof value === 'string' && isKeptString(value, meaning) && keptOrSecretMark(value) === value;
};

/** Returns the size of the result, followed by its top-level scalar fields that pass the list of `argumentsExcerpt`; never a free text. */
export function resultExcerpt(resultText: string): string {
  const sizeMark = `[result len=${resultText.length}]`;
  const fields = Object.entries(parsedJsonObjectOf(resultText) ?? {}).slice(0, MAX_WALK_ITEMS);
  const keptFields = fields.filter(isKeptScalarField);
  return keptFields.length === 0 ? sizeMark : `${sizeMark} ${JSON.stringify(Object.fromEntries(keptFields))}`;
}

/** Returns an error code, a class name, a version or an identifier as it is; any other text stands as its length and fingerprint. */
export function keptTokenOrMark(text: string): string {
  const isToken = text.length <= MAX_KEPT_SCALAR_CHARS && IDENTIFIER.test(text);
  return isToken ? keptOrSecretMark(text) : textMark(text);
}
