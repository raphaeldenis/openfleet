import { createHash } from 'node:crypto';
import { KernelError } from './kernelError.js';

const refusal = (reason: string): KernelError => new KernelError('not_canonical_json', `the value has no canonical JSON form: ${reason}.`);

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const canonicalTextOf = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw refusal('a number is not finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw refusal(`a ${typeof value} cannot be written`);
  if (ancestors.has(value)) throw refusal('the structure is cyclic');
  if (!Array.isArray(value) && !isPlainObject(value)) throw refusal('only plain objects and arrays can be written');

  ancestors.add(value);
  const text = Array.isArray(value) ? canonicalArrayOf(value, ancestors) : canonicalObjectOf(value as Record<string, unknown>, ancestors);
  ancestors.delete(value);
  return text;
};

const canonicalArrayOf = (elements: unknown[], ancestors: Set<object>): string => {
  const writtenElements = elements.map((element) => (element === undefined ? 'null' : canonicalTextOf(element, ancestors)));
  return `[${writtenElements.join(',')}]`;
};

const canonicalObjectOf = (object: Record<string, unknown>, ancestors: Set<object>): string => {
  const sortedKeys = Object.keys(object).sort();
  const writtenMembers = sortedKeys
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalTextOf(object[key], ancestors)}`);
  return `{${writtenMembers.join(',')}}`;
};

/** Returns the JSON text of `value` with object keys sorted at every depth and no whitespace; undefined object members are omitted, as JSON does. */
export const canonicalJsonOf = (value: unknown): string => canonicalTextOf(value, new Set());

/** Returns the lowercase sha256 hex of the canonical JSON of `value`: the same content gives the same digest whatever the key order. */
export const canonicalDigestOf = (value: unknown): string => createHash('sha256').update(canonicalJsonOf(value)).digest('hex');
