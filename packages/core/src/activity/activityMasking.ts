import { redactedText, withoutUnrenderableCharacters } from '../logger.js';
import { maskedCommandSecrets } from '../policy/commandSecrets.js';
import { isSecretEntry, MASK } from '../redact.js';

const MAX_STRUCTURE_DEPTH = 8;
const CIRCULAR_MARK = '[circular]';
const TOO_DEEP_MARK = '[depth]';
const UNSERIALIZABLE_MARK = '[unserializable]';

/** Returns the text without control or bidirectional characters, which could split a flag name, then with every credential masked. */
export function maskedActivityText(text: string): string {
  const printable = withoutUnrenderableCharacters(text);
  return redactedText(maskedCommandSecrets(printable));
}

function maskedStructure(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (typeof value === 'string') return maskedActivityText(value);
  const isLeaf = value === null || typeof value !== 'object';
  if (isLeaf) return value;
  if (ancestors.has(value)) return CIRCULAR_MARK;
  if (depth >= MAX_STRUCTURE_DEPTH) return TOO_DEEP_MARK;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => maskedStructure(item, ancestors, depth + 1));
    const maskedEntries = Object.entries(value).map(([key, entry]) => [
      maskedActivityText(key),
      isSecretEntry(key, entry) ? MASK : maskedStructure(entry, ancestors, depth + 1),
    ]);
    return Object.fromEntries(maskedEntries);
  } finally {
    ancestors.delete(value);
  }
}

/** Returns the JSON of a structure whose every string is masked before it is serialized, so a quote the JSON escapes cannot hide the end of a secret. */
export function maskedStructureText(structure: unknown): string {
  try {
    return JSON.stringify(maskedStructure(structure, new Set(), 0)) ?? '';
  } catch {
    return UNSERIALIZABLE_MARK;
  }
}

/** Returns a text holding JSON with its strings masked one by one, and any other text masked as a whole. */
export function maskedTextOrJson(text: string): string {
  try {
    return maskedStructureText(JSON.parse(text));
  } catch {
    return maskedActivityText(text);
  }
}
