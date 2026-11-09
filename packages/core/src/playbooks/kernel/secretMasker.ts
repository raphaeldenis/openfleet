import { escapedForRegExp } from '../../redact.js';
import { KernelError } from './kernelError.js';
import { SECRET_NAME } from './secretName.js';

export const MIN_SECRET_LENGTH = 8;

export type SecretToMask = { name: string; value: string };

export type SecretMasker = {
  /**
   * Replaces each occurrence of a secret, in any of its forms, by `[secret:NAME]`.
   * Forms: plain, URL-encoded and form-encoded (`%XX` in either hex case), base64, base64url, JSON-escaped (also `\uXXXX` for non-ASCII characters in either hex case, and `\/`).
   * Known limits: a secret split across two calls is recognised in neither; one that a script hashes, splits or re-encodes in another way stays readable
   * (Unicode NFC/NFD normalisation, double URL-encoding, hexadecimal, a changed letter case, `encodeURI`-style encodings of `!'()*`).
   * The marker `[secret:NAME]` is plain text: an agent output can forge it, so it never proves that a value was masked.
   */
  mask: (text: string) => string;
  /** The length in characters of the longest spelling of any secret, at least 1: a text cut shorter than this beyond the ceiling can hide the start of a secret from `mask`. */
  longestSpellingLength: number;
};

type Match = { start: number; end: number; name: string };

const markerOf = (name: string): string => `[secret:${name}]`;

const lengthInCharacters = (text: string): number => Array.from(text).length;

const withoutPadding = (base64: string): string => base64.replace(/=+$/, '');

const NON_ASCII_CODE_UNIT = /[^\u0000-\u007f]/g;

const unicodeEscapeOf = (codeUnit: string): string => `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** The JSON spellings of a value: as JSON.stringify writes it, with non-ASCII characters as \uXXXX, and each of those with `/` escaped as `\/`. */
const jsonFormsOf = (value: string): string[] => {
  const asStringifyWritesIt = JSON.stringify(value).slice(1, -1);
  const withUnicodeEscapes = asStringifyWritesIt.replace(NON_ASCII_CODE_UNIT, unicodeEscapeOf);
  return [asStringifyWritesIt, withUnicodeEscapes, asStringifyWritesIt.replaceAll('/', '\\/'), withUnicodeEscapes.replaceAll('/', '\\/')];
};

/** The spellings a value takes in an output: plain, URL-encoded, form-encoded, base64 and base64url (unpadded, so the padded form is covered), JSON-escaped. */
const formsOf = (value: string): string[] => {
  const urlEncoded = encodeURIComponent(value);
  return [
    value,
    urlEncoded,
    urlEncoded.replaceAll('%20', '+'),
    withoutPadding(Buffer.from(value).toString('base64')),
    withoutPadding(Buffer.from(value).toString('base64url')),
    ...jsonFormsOf(value),
  ];
};

const HEX_SEQUENCE = /(%[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4})/;
const HEX_SEQUENCE_EVERYWHERE = new RegExp(HEX_SEQUENCE.source, 'g');

/** Writes the `%XX` and `\uXXXX` sequences of a spelling with lowercase hexadecimal, so that spellings differing only by that case share one key. */
const withLowercaseHex = (spelling: string): string => spelling.replace(HEX_SEQUENCE_EVERYWHERE, (sequence) => sequence.toLowerCase());

const caseInsensitiveHex = (escapedSequence: string): string => escapedSequence.replace(/[a-f]/gi, (digit) => `[${digit.toLowerCase()}${digit.toUpperCase()}]`);

/** The regular-expression source matching a spelling literally, but accepting either case in each `%XX` and `\uXXXX` sequence; one character class per hex letter keeps the scan linear. */
const patternOf = (spelling: string): string =>
  spelling
    .split(HEX_SEQUENCE)
    .map((piece, index) => (index % 2 === 1 ? caseInsensitiveHex(escapedForRegExp(piece)) : escapedForRegExp(piece)))
    .join('');

const assertMaskable = ({ name, value }: SecretToMask): void => {
  if (!SECRET_NAME.test(name)) throw new KernelError('invalid_secret_name', `"${name}" is not a secret name (letters, digits and underscores, not starting with a digit).`);
  if (lengthInCharacters(value) < MIN_SECRET_LENGTH) throw new KernelError('secret_too_short', `the secret ${name} has fewer than ${MIN_SECRET_LENGTH} characters: masking it would destroy the output.`);
};

/** Maps each spelling (hexadecimal in lowercase) to the first secret that owns it, longest spelling first, so that the alternation of the scan prefers the longest match at a position. */
const namesBySpelling = (secrets: readonly SecretToMask[]): Map<string, string> => {
  const owners = new Map<string, string>();
  for (const { name, value } of secrets) for (const form of formsOf(value).map(withLowercaseHex)) if (!owners.has(form)) owners.set(form, name);
  return new Map([...owners].sort(([spellingA], [spellingB]) => spellingB.length - spellingA.length));
};

/** Every match, overlapping ones included, in order of start; at one start, the longest spelling first. */
type MatchFinder = (text: string) => Match[];

/** Finds the spellings by string search, for spellings too large for one regular expression. The hexadecimal case is folded on both sides; folding keeps the length. */
const stringSearchFinderOf = (nameOf: Map<string, string>): MatchFinder => (text) => {
  const foldedText = withLowercaseHex(text);
  const matches: Match[] = [];
  for (const [spelling, name] of nameOf) {
    for (let start = foldedText.indexOf(spelling); start !== -1; start = foldedText.indexOf(spelling, start + 1)) {
      matches.push({ start, end: start + spelling.length, name });
    }
  }
  return matches.sort((matchA, matchB) => matchA.start - matchB.start);
};

/** The regular expression of the spellings, or undefined when they are too large for the engine to compile it. The engine compiles at the first match attempt, so one empty attempt forces the error here. */
const compiledScanOf = (nameOf: Map<string, string>): RegExp | undefined => {
  try {
    const scan = new RegExp([...nameOf.keys()].map(patternOf).join('|'), 'g');
    scan.test('');
    return scan;
  } catch {
    return undefined;
  }
};

/** Every match, overlapping ones included, in order of start; at one start, the longest spelling. */
const matchesOf = (text: string, scan: RegExp, nameOf: Map<string, string>): Match[] => {
  const matches: Match[] = [];
  scan.lastIndex = 0;
  for (let found = scan.exec(text); found; found = scan.exec(text)) {
    const spelling = found[0];
    matches.push({ start: found.index, end: found.index + spelling.length, name: nameOf.get(withLowercaseHex(spelling)) ?? '' });
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

/** The start of the merged region of matches that holds `position` strictly inside, or undefined when no region does. */
const startOfRegionCrossing = (matches: readonly Match[], position: number): number | undefined => {
  let regionStart = -1;
  let regionEnd = -1;
  const crossesPosition = () => regionStart < position && position < regionEnd;
  for (const match of matches) {
    if (match.start < regionEnd) {
      regionEnd = Math.max(regionEnd, match.end);
      continue;
    }
    if (crossesPosition()) return regionStart;
    regionStart = match.start;
    regionEnd = match.end;
  }
  return crossesPosition() ? regionStart : undefined;
};

const isHighSurrogate = (codeUnit: number): boolean => codeUnit >= 0xd800 && codeUnit <= 0xdbff;

/** The largest position up to `maxChars` that falls neither inside a secret nor between the two halves of a surrogate pair. */
const cutPositionOf = ({ text, matches, maxChars }: { text: string; matches: readonly Match[]; maxChars: number }): number => {
  const cut = startOfRegionCrossing(matches, maxChars) ?? maxChars;
  const splitsSurrogatePair = isHighSurrogate(text.charCodeAt(cut - 1));
  return splitsSurrogatePair ? cut - 1 : cut;
};

export type SecretMaskerOptions = {
  /** The most characters of a text that `mask` reads; the rest is replaced by `[truncated]`. */
  maxInputChars?: number;
};

export const DEFAULT_MAX_INPUT_CHARS = 262_144;
const TRUNCATION_MARKER = '[truncated]';

/**
 * Builds a masker from the values of the secrets a run resolved.
 * Throws secret_too_short for a value under MIN_SECRET_LENGTH characters and invalid_secret_name for a name that cannot sit in a marker; `mask` never throws.
 * Spellings too large for one regular expression are found by string search instead.
 * The scan is one pass over the text per call. A text longer than `maxInputChars` (default 262 144) is cut before the scan and ends with `[truncated]`;
 * the cut moves back before any secret it would split, so no piece of a secret survives it.
 */
export const createSecretMasker = (secrets: readonly SecretToMask[], { maxInputChars = DEFAULT_MAX_INPUT_CHARS }: SecretMaskerOptions = {}): SecretMasker => {
  secrets.forEach(assertMaskable);

  const nameOf = namesBySpelling(secrets);
  const scan = compiledScanOf(nameOf);
  const longestSpelling = nameOf.size === 0 ? 1 : Array.from(nameOf.keys()).reduce((longest, spelling) => Math.max(longest, spelling.length), 1);
  const findMatches: MatchFinder = scan === undefined ? stringSearchFinderOf(nameOf) : (text) => matchesOf(text, scan, nameOf);
  const matchesIn: MatchFinder = (text) => (secrets.length === 0 ? [] : findMatches(text));

  const mask = (text: string): string => {
    const isWithinCeiling = text.length <= maxInputChars;
    if (isWithinCeiling) return maskedWith(text, matchesIn(text));

    const windowReachingEveryStraddlingSecret = text.slice(0, maxInputChars + longestSpelling - 1);
    const matches = matchesIn(windowReachingEveryStraddlingSecret);
    const cut = cutPositionOf({ text, matches, maxChars: maxInputChars });
    const matchesBeforeTheCut = matches.filter((match) => match.end <= cut);
    return maskedWith(text.slice(0, cut), matchesBeforeTheCut) + TRUNCATION_MARKER;
  };
  return { mask, longestSpellingLength: longestSpelling };
};
