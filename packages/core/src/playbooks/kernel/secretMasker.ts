import { escapedForRegExp } from '../../redact.js';
import { KernelError } from './kernelError.js';
import { SECRET_NAME } from './secretName.js';

export const MIN_SECRET_LENGTH = 8;

export type SecretToMask = { name: string; value: string };

export type SecretMasker = {
  /**
   * Replaces each occurrence of a secret, in any of its forms, by `[secret:NAME]`.
   * Known limits: a secret split across two calls is recognised in neither; one that a script hashes, splits or re-encodes in another way stays readable.
   */
  mask: (text: string) => string;
};

type Match = { start: number; end: number; name: string };

const markerOf = (name: string): string => `[secret:${name}]`;

const lengthInCharacters = (text: string): number => Array.from(text).length;

const withoutPadding = (base64: string): string => base64.replace(/=+$/, '');

/** The spellings a value takes in an output: plain, URL-encoded, form-encoded, base64 and base64url (unpadded, so the padded form is covered), JSON-escaped. */
const formsOf = (value: string): string[] => {
  const urlEncoded = encodeURIComponent(value);
  return [
    value,
    urlEncoded,
    urlEncoded.replaceAll('%20', '+'),
    withoutPadding(Buffer.from(value).toString('base64')),
    withoutPadding(Buffer.from(value).toString('base64url')),
    JSON.stringify(value).slice(1, -1),
  ];
};

const assertMaskable = ({ name, value }: SecretToMask): void => {
  if (!SECRET_NAME.test(name)) throw new KernelError('invalid_secret_name', `"${name}" is not a secret name (letters, digits and underscores, not starting with a digit).`);
  if (lengthInCharacters(value) < MIN_SECRET_LENGTH) throw new KernelError('secret_too_short', `the secret ${name} has fewer than ${MIN_SECRET_LENGTH} characters: masking it would destroy the output.`);
};

/** Maps each spelling to the first secret that owns it, longest spelling first, so that the alternation of the scan prefers the longest match at a position. */
const namesBySpelling = (secrets: readonly SecretToMask[]): Map<string, string> => {
  const owners = new Map<string, string>();
  for (const { name, value } of secrets) for (const form of formsOf(value)) if (!owners.has(form)) owners.set(form, name);
  return new Map([...owners].sort(([spellingA], [spellingB]) => spellingB.length - spellingA.length));
};

/** Every match, overlapping ones included, in order of start; at one start, the longest spelling. */
const matchesOf = (text: string, scan: RegExp, nameOf: Map<string, string>): Match[] => {
  const matches: Match[] = [];
  scan.lastIndex = 0;
  for (let found = scan.exec(text); found; found = scan.exec(text)) {
    const spelling = found[0];
    matches.push({ start: found.index, end: found.index + spelling.length, name: nameOf.get(spelling) ?? '' });
    scan.lastIndex = found.index + 1;
  }
  return matches;
};

/** Writes the text with each region covered by matches replaced by the markers of the secrets that extend it; a match inside the region of a longer one adds nothing. */
const maskedWith = (text: string, matches: readonly Match[]): string => {
  let masked = '';
  let copiedUpTo = 0;
  let regionEnd = -1;
  let regionNames: string[] = [];
  const closeRegion = () => {
    masked += regionNames.map(markerOf).join('');
    regionNames = [];
  };
  for (const match of matches) {
    const startsNewRegion = match.start >= regionEnd;
    const extendsRegion = match.end > regionEnd;
    if (startsNewRegion) {
      closeRegion();
      masked += text.slice(copiedUpTo, match.start);
    }
    if (startsNewRegion || extendsRegion) {
      if (!regionNames.includes(match.name)) regionNames.push(match.name);
      regionEnd = match.end;
      copiedUpTo = match.end;
    }
  }
  closeRegion();
  return masked + text.slice(copiedUpTo);
};

/**
 * Builds a masker from the values of the secrets a run resolved.
 * Throws secret_too_short for a value under MIN_SECRET_LENGTH characters and invalid_secret_name for a name that cannot sit in a marker.
 * The scan is one pass over the text per call.
 */
export const createSecretMasker = (secrets: readonly SecretToMask[]): SecretMasker => {
  secrets.forEach(assertMaskable);
  if (secrets.length === 0) return { mask: (text) => text };

  const nameOf = namesBySpelling(secrets);
  const scan = new RegExp([...nameOf.keys()].map(escapedForRegExp).join('|'), 'g');
  return { mask: (text) => maskedWith(text, matchesOf(text, scan, nameOf)) };
};
