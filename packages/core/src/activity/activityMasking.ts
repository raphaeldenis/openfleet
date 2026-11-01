import { redactedText, withoutUnrenderableCharacters } from '../logger.js';
import { maskedCommandSecrets } from '../policy/commandSecrets.js';
import { isSecretEntry, MASK, maskingCutCredential } from '../redact.js';

const MAX_STRUCTURE_DEPTH = 8;
const CIRCULAR_MARK = '[circular]';
const TOO_DEEP_MARK = '[depth]';
const UNSERIALIZABLE_MARK = '[unserializable]';
const PAST_THE_BUDGET_MARK = '[cut]';

// The stored excerpts keep a few hundred characters: masking more than the bound spends the daemon's thread on text nobody reads.
const MAX_MASKED_TEXT_CHARS = 8 * 1024;
const MAX_MASKED_STRUCTURE_CHARS = 64 * 1024;
const MAX_PARSED_JSON_CHARS = 256 * 1024;

// The shell splits words on these: dropping them as unrenderable would glue a flag to its value.
const WORD_SEPARATING_CHARACTERS = /[\t\n\v\f\r\u0085\p{Zl}\p{Zp}]/gu;

/** Cuts the text at the bound before anything scans it; a credential the cut leaves too short for its rule is masked by its prefix. */
const boundedForMasking = (text: string): string => (text.length > MAX_MASKED_TEXT_CHARS ? maskingCutCredential(text.slice(0, MAX_MASKED_TEXT_CHARS)) : text);

/**
 * Returns the text cut at its bound, without control or bidirectional characters, which could split a flag name, then with every credential masked.
 * A tab or a line break becomes a space, so the words on either side of it stay apart.
 * Known limits, left readable: an assignment whose name holds no secret word (`X=value cmd`), a flag spelled with look-alike characters, and a value under an arbitrary name that has no recognisable format.
 */
export function maskedActivityText(text: string): string {
  const printable = withoutUnrenderableCharacters(boundedForMasking(text).replace(WORD_SEPARATING_CHARACTERS, ' '));
  return redactedText(maskedCommandSecrets(printable));
}

interface StructureWalk {
  ancestors: Set<object>;
  charsLeft: number;
}

/** Masks a string while the budget of the call lasts; past it, a mark stands for the string. */
const maskedWithinBudget = (text: string, walk: StructureWalk): string => {
  if (walk.charsLeft <= 0) return PAST_THE_BUDGET_MARK;
  walk.charsLeft -= Math.min(text.length, MAX_MASKED_TEXT_CHARS);
  return maskedActivityText(text);
};

function maskedStructure(value: unknown, walk: StructureWalk, depth: number): unknown {
  if (typeof value === 'string') return maskedWithinBudget(value, walk);
  const isLeaf = value === null || typeof value !== 'object';
  if (isLeaf) return value;
  if (walk.ancestors.has(value)) return CIRCULAR_MARK;
  if (depth >= MAX_STRUCTURE_DEPTH) return TOO_DEEP_MARK;
  if (walk.charsLeft <= 0) return PAST_THE_BUDGET_MARK;
  walk.ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => maskedStructure(item, walk, depth + 1));
    const maskedEntries = Object.entries(value).map(([key, entry]) => [
      maskedWithinBudget(key, walk),
      isSecretEntry(key, entry) ? MASK : maskedStructure(entry, walk, depth + 1),
    ]);
    return Object.fromEntries(maskedEntries);
  } finally {
    walk.ancestors.delete(value);
  }
}

/** Returns the JSON of a structure whose every string is masked before it is serialized, so a quote the JSON escapes cannot hide the end of a secret; past the character budget of the call, a mark stands for each string. */
export function maskedStructureText(structure: unknown): string {
  try {
    return JSON.stringify(maskedStructure(structure, { ancestors: new Set(), charsLeft: MAX_MASKED_STRUCTURE_CHARS }, 0)) ?? '';
  } catch {
    return UNSERIALIZABLE_MARK;
  }
}

/** Returns a text holding JSON with its strings masked one by one, and any other text, or one too long to parse, masked as a whole. */
export function maskedTextOrJson(text: string): string {
  if (text.length > MAX_PARSED_JSON_CHARS) return maskedActivityText(text);
  try {
    return maskedStructureText(JSON.parse(text));
  } catch {
    return maskedActivityText(text);
  }
}
