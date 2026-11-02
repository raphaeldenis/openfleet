import { MASK, maskedSecrets, SECRET_KEY } from '../redact.js';

/**
 * For each character of a word, where the scanned source holds it: the character as written (`\"`, `x`)
 * and the segment around it (a quoted segment, an escape, or the plain character itself).
 */
interface CharacterPositions {
  charStarts: number[];
  charEnds: number[];
  segmentStarts: number[];
  segmentEnds: number[];
}

/** One shell word: the text the shell passes to the program, and where the word sits in the scanned source. */
interface ShellWord {
  text: string;
  source: string;
  start: number;
  end: number;
  startsACommand: boolean;
  isMasked: boolean;
  positions?: CharacterPositions;
}

/** A stretch of a source, start included, end excluded. */
interface SourceRange {
  start: number;
  end: number;
}

/** Turns a range of the scanned source into the range of the original command that holds it. */
type ToCommandRange = (range: SourceRange) => SourceRange;

const WORD_GAP = /[\s\u0085]/;
const COMMAND_SEPARATORS = new Set([';', '&', '|', '(', ')', '\n', '\r']);
const ESCAPABLE_INSIDE_DOUBLE_QUOTES = new Set(['$', '`', '"', '\\', '\n']);

const ASCII_WORD_ENDS = Array.from({ length: 128 }, (_, code) => {
  const character = String.fromCharCode(code);
  return WORD_GAP.test(character) || COMMAND_SEPARATORS.has(character);
});

const endsTheWord = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code < ASCII_WORD_ENDS.length ? ASCII_WORD_ENDS[code]! : WORD_GAP.test(character);
};

/** Gathers the characters of a word, segment by segment; when asked, also where each one was written. */
class ShellWordBuilder {
  text = '';
  private segmentStart = 0;
  private segmentFirstChar = 0;

  constructor(readonly positions?: CharacterPositions) {}

  openSegment(start: number): void {
    this.segmentStart = start;
    this.segmentFirstChar = this.text.length;
  }

  add(characters: string, start: number, end: number): void {
    this.text += characters;
    if (!this.positions) return;
    for (let unit = 0; unit < characters.length; unit += 1) {
      this.positions.charStarts.push(start);
      this.positions.charEnds.push(end);
      this.positions.segmentStarts.push(this.segmentStart);
    }
  }

  closeSegment(end: number): void {
    if (!this.positions) return;
    for (let index = this.segmentFirstChar; index < this.text.length; index += 1) this.positions.segmentEnds.push(end);
  }
}

/** `'…'`: no escape inside; one that never closes runs to the end of the source. Returns where the segment ends. */
const readSingleQuoted = (source: string, openingAt: number, word: ShellWordBuilder): number => {
  const closingAt = source.indexOf("'", openingAt + 1);
  const contentEnd = closingAt === -1 ? source.length : closingAt;
  for (let at = openingAt + 1; at < contentEnd; at += 1) word.add(source.charAt(at), at, at + 1);
  return closingAt === -1 ? source.length : closingAt + 1;
};

/** `"…"`: a backslash escapes `"`, `\`, `$`, a backtick and a line break; one that never closes runs to the end of the source. */
const readDoubleQuoted = (source: string, openingAt: number, word: ShellWordBuilder): number => {
  let at = openingAt + 1;
  while (at < source.length) {
    const character = source.charAt(at);
    if (character === '"') return at + 1;
    const nextCharacter = source.charAt(at + 1);
    const isEscape = character === '\\' && at + 1 < source.length && ESCAPABLE_INSIDE_DOUBLE_QUOTES.has(nextCharacter);
    const width = isEscape ? 2 : 1;
    word.add(isEscape ? nextCharacter : character, at, at + width);
    at += width;
  }
  return source.length;
};

const ANSI_C_LETTER_ESCAPES = new Map([
  ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'],
  ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'],
]);
const HEX_DIGIT = /[0-9a-fA-F]/;
const OCTAL_DIGIT = /[0-7]/;
const ANSI_C_CODE_ESCAPES = new Map([
  ['x', { maxDigits: 2 }],
  ['u', { maxDigits: 4 }],
  ['U', { maxDigits: 8 }],
]);
const OCTAL_ESCAPE_MAX_DIGITS = 3;
const BYTE_MASK = 0xff;
const CONTROL_CHARACTER_MASK = 0x1f;
const LAST_CODE_POINT = 0x10ffff;
// What an escape decodes to when it names no character: the word then reads as illegible.
const ILLEGIBLE_CHARACTER = '�';

const endOfDigits = (source: string, from: number, digit: RegExp, maxDigits: number): number => {
  let end = from;
  while (end < source.length && end - from < maxDigits && digit.test(source.charAt(end))) end += 1;
  return end;
};

const characterOfCode = (code: number): string => (code <= LAST_CODE_POINT ? String.fromCodePoint(code) : ILLEGIBLE_CHARACTER);

type DecodedEscape = { text: string; end: number };

/** The escape of `$'…'` whose backslash sits at `at`, as bash decodes it: `\n`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\NNN`, `\cX`; an unknown one keeps its backslash. */
const ansiCEscapeAt = (source: string, at: number): DecodedEscape => {
  const letter = source.charAt(at + 1);
  const letterEscape = ANSI_C_LETTER_ESCAPES.get(letter);
  if (letterEscape !== undefined) return { text: letterEscape, end: at + 2 };
  const isControlEscape = letter === 'c' && at + 2 < source.length;
  if (isControlEscape) return { text: String.fromCharCode(source.charCodeAt(at + 2) & CONTROL_CHARACTER_MASK), end: at + 3 };
  const codeEscape = ANSI_C_CODE_ESCAPES.get(letter);
  if (codeEscape !== undefined) {
    const digitsEnd = endOfDigits(source, at + 2, HEX_DIGIT, codeEscape.maxDigits);
    const hasNoDigit = digitsEnd === at + 2;
    if (hasNoDigit) return { text: `\\${letter}`, end: at + 2 };
    return { text: characterOfCode(parseInt(source.slice(at + 2, digitsEnd), 16)), end: digitsEnd };
  }
  if (OCTAL_DIGIT.test(letter)) {
    const digitsEnd = endOfDigits(source, at + 1, OCTAL_DIGIT, OCTAL_ESCAPE_MAX_DIGITS);
    return { text: String.fromCharCode(parseInt(source.slice(at + 1, digitsEnd), 8) & BYTE_MASK), end: digitsEnd };
  }
  return { text: `\\${letter}`, end: Math.min(at + 2, source.length) };
};

/** `$'…'`: every escape decoded as bash decodes it, so `$'\x63url'` reads `curl`; one that never closes runs to the end of the source. */
const readAnsiCQuoted = (source: string, openingAt: number, word: ShellWordBuilder): number => {
  let at = openingAt + 2;
  while (at < source.length) {
    const character = source.charAt(at);
    if (character === "'") return at + 1;
    const escape = character === '\\' ? ansiCEscapeAt(source, at) : { text: character, end: at + 1 };
    word.add(escape.text, at, escape.end);
    at = escape.end;
  }
  return source.length;
};

/** Reads the segment of a word that starts at `at` (an escaped character, a quoted segment or one plain character) and returns where it ends. */
const readSegment = (source: string, at: number, word: ShellWordBuilder): number => {
  const character = source.charAt(at);
  const nextCharacter = source.charAt(at + 1);
  if (character === '\\') {
    const end = Math.min(at + 2, source.length);
    word.add(nextCharacter, at, end);
    return end;
  }
  if (character === "'") return readSingleQuoted(source, at, word);
  if (character === '"') return readDoubleQuoted(source, at, word);
  const opensAnsiCQuotes = character === '$' && nextCharacter === "'";
  if (opensAnsiCQuotes) return readAnsiCQuoted(source, at, word);
  word.add(character, at, at + 1);
  return at + 1;
};

/** Reads the word that starts at `start`: unquoted runs, quoted segments and escaped characters glued together, as the shell joins them. Returns where it ends. */
const readWord = (source: string, start: number, word: ShellWordBuilder): number => {
  let at = start;
  while (at < source.length && !endsTheWord(source.charAt(at))) {
    word.openSegment(at);
    at = readSegment(source, at, word);
    word.closeSegment(at);
  }
  return at;
};

/** Reads the word again, once, this time keeping where each of its characters was written; only a word that gets masked pays for it. */
const positionsOf = (word: ShellWord): CharacterPositions => {
  if (word.positions) return word.positions;
  word.positions = { charStarts: [], charEnds: [], segmentStarts: [], segmentEnds: [] };
  readWord(word.source, word.start, new ShellWordBuilder(word.positions));
  return word.positions;
};

/** Splits a source into its words in one pass; a separator (`;`, `&`, `|`, a parenthesis, a line break) in the gap before a word starts a new command. */
const shellWordsOf = (source: string): ShellWord[] => {
  const words: ShellWord[] = [];
  let at = 0;
  while (at < source.length) {
    let holdsASeparator = false;
    while (at < source.length && endsTheWord(source.charAt(at))) {
      holdsASeparator ||= COMMAND_SEPARATORS.has(source.charAt(at));
      at += 1;
    }
    if (at >= source.length) return words;
    const builder = new ShellWordBuilder();
    const start = at;
    at = readWord(source, start, builder);
    words.push({ text: builder.text, source, start, end: at, startsACommand: words.length === 0 || holdsASeparator, isMasked: false });
  }
  return words;
};

/**
 * Where the source holds the characters `from` to `to` of a word.
 * A value that fills whole segments takes their quotes along (`--password "a b"` → `--password ***`);
 * a value inside one segment leaves the quotes around it (`"Authorization: Bearer ***"`, `$'X-Api-Key: ***'`).
 */
const sourceRangeOf = (word: ShellWord, from: number, to: number): SourceRange => {
  const isAnEmptyWord = word.text === '';
  if (isAnEmptyWord) return { start: word.start, end: word.end };
  const { charStarts, charEnds, segmentStarts, segmentEnds } = positionsOf(word);
  const last = to - 1;
  const isInsideOneSegment = segmentStarts[from] === segmentStarts[last];
  const startsASegment = from === 0 || segmentStarts[from - 1] !== segmentStarts[from];
  const endsASegment = to === word.text.length || segmentStarts[to] !== segmentStarts[last];
  const fillsWholeSegments = startsASegment && endsASegment;
  if (isInsideOneSegment && !fillsWholeSegments) return { start: charStarts[from]!, end: charEnds[last]! };
  return { start: segmentStarts[from]!, end: segmentEnds[last]! };
};

const SECRET_FLAG_WORDS = new Set(['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization', 'auth', 'bearer', 'credential', 'credentials']);
// `--password-stdin`, `--token-file`: the option names where the secret comes from, not the secret.
const SECRET_SOURCE_WORDS = new Set(['stdin', 'file', 'prompt']);
const FLAG_NAME_SEGMENT = /^[a-z0-9]+$/;
const LEADING_DASHES = /^-+/;

/** `--token`, `--db-password`, `--api-key`, `--token-count`, but not `--password-stdin`, `--authorization-file` or `--author`. */
const isSecretFlagName = (name: string): boolean => {
  if (!name.startsWith('--')) return false;
  const segments = name.replace(LEADING_DASHES, '').toLowerCase().split('-');
  if (!segments.every((segment) => FLAG_NAME_SEGMENT.test(segment))) return false;
  return segments.some((segment, index) => {
    const isApiKeyPair = segment === 'api' && segments[index + 1] === 'key';
    if (!SECRET_FLAG_WORDS.has(segment) && !isApiKeyPair) return false;
    const wordAfterTheSecret = segments[index + (isApiKeyPair ? 2 : 1)];
    return wordAfterTheSecret === undefined || !SECRET_SOURCE_WORDS.has(wordAfterTheSecret);
  });
};

/** `--token`, `--db-password`, `--api-key`: a name that ends on the secret always takes the next word as its value, even one that starts with a dash; `--token-count`, `--auth-type` or `--no-auth` may stand alone. */
const alwaysTakesAValue = (flagName: string): boolean => {
  const segments = flagName.replace(LEADING_DASHES, '').toLowerCase().split('-');
  const lastSegment = segments[segments.length - 1] ?? '';
  const endsOnApiKey = segments[segments.length - 2] === 'api' && lastSegment === 'key';
  const isANegation = segments[0] === 'no';
  return !isANegation && (SECRET_FLAG_WORDS.has(lastSegment) || endsOnApiKey);
};

const SECRET_IN_VARIABLE_NAME =/password|passwd|passphrase|secret|token|api_?key|auth|bearer|credential/i;
const VARIABLE_NAME_CHARACTER = /[A-Za-z0-9_]/;
const AUTHORIZATION_SCHEME_WORD = /^(?:bearer|basic|token)$/i;
const HEADER_NAME_AND_COLON = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*/;
const AUTHORIZATION_SCHEME_PREFIX = /^(?:bearer|basic|token)[ \t]+/i;
const URL_AUTHORITY_END = /[\s/?#]/;
const ALREADY_MASKED_VALUE = /^\*\*\*["'}\],]*$/;
const NOT_FOUND = undefined;

const isAlreadyMasked = (value: string): boolean => ALREADY_MASKED_VALUE.test(value);

/**
 * `API_KEY=…`, `-eDB_PASSWORD=…`, `user=x&token=…`: where the secret starts, after the first `=` that closes a name holding a secret word.
 * The secret runs to the end of the word, spaces included: `-e "DB_PASSWORD=a b"` hides `a b`, and `echo 'API_KEY=example documentation'`
 * hides `example documentation` too; a journal of refused commands masks a sentence rather than leave half a password readable.
 */
const assignedSecretStart = (text: string): number | undefined => {
  for (let equalsAt = text.indexOf('='); equalsAt !== -1; equalsAt = text.indexOf('=', equalsAt + 1)) {
    let nameStart = equalsAt;
    while (nameStart > 0 && VARIABLE_NAME_CHARACTER.test(text.charAt(nameStart - 1))) nameStart -= 1;
    const value = text.slice(equalsAt + 1);
    const namesASecret = SECRET_IN_VARIABLE_NAME.test(text.slice(nameStart, equalsAt));
    if (namesASecret && value !== '' && !isAlreadyMasked(value)) return equalsAt + 1;
  }
  return NOT_FOUND;
};

/** `Authorization: Bearer …`, `X-Api-Key: …`: where the value of a header named after a credential starts, its scheme word kept readable. */
const headerCredentialStart = (text: string): number | undefined => {
  const header = text.includes(':') ? HEADER_NAME_AND_COLON.exec(text) : null;
  if (!header) return NOT_FOUND;
  const [prefix = '', name = ''] = header;
  const namesASecret = SECRET_KEY.test(name) || SECRET_IN_VARIABLE_NAME.test(name);
  const value = text.slice(prefix.length);
  const scheme = AUTHORIZATION_SCHEME_PREFIX.exec(value)?.[0] ?? '';
  const credential = value.slice(scheme.length);
  if (!namesASecret || credential === '' || isAlreadyMasked(credential)) return NOT_FOUND;
  return prefix.length + scheme.length;
};

/** `scheme://user:password@host`: the credentials end at the last `@` before the host ends (a password may hold an `@`, never a `/`). */
const urlCredentialRanges = (text: string): SourceRange[] => {
  const firstSchemeEnd = text.indexOf('://');
  if (firstSchemeEnd === -1) return [];
  const ranges: SourceRange[] = [];
  for (let schemeEnd = firstSchemeEnd; schemeEnd !== -1; ) {
    const authorityStart = schemeEnd + 3;
    let authorityEnd = authorityStart;
    let lastAtSign = -1;
    while (authorityEnd < text.length && !URL_AUTHORITY_END.test(text.charAt(authorityEnd))) {
      if (text.charAt(authorityEnd) === '@') lastAtSign = authorityEnd;
      authorityEnd += 1;
    }
    const credentials = lastAtSign === -1 ? '' : text.slice(authorityStart, lastAtSign);
    if (credentials !== '' && credentials !== MASK) ranges.push({ start: authorityStart, end: lastAtSign });
    schemeEnd = text.indexOf('://', Math.max(authorityEnd, authorityStart));
  }
  return ranges;
};

/** `alice:password` → where `password` starts; a user without a password stays readable (the program prompts for it). */
const userPasswordStart = (userAndPassword: string): number | undefined => {
  const colonAt = userAndPassword.indexOf(':');
  const password = colonAt === -1 ? '' : userAndPassword.slice(colonAt + 1);
  if (password === '' || isAlreadyMasked(password)) return NOT_FOUND;
  return colonAt + 1;
};

const attachedValueStart = (text: string, optionPrefix: RegExp): number | undefined => {
  const prefix = optionPrefix.exec(text)?.[0];
  if (prefix === undefined || isAlreadyMasked(text.slice(prefix.length))) return NOT_FOUND;
  return prefix.length;
};

const WORD_GAP_OR_SEPARATOR = /[\s\u0085;&|()]/;

const holdsSeveralWords = (text: string): boolean => WORD_GAP_OR_SEPARATOR.test(text);

const MAX_NESTED_COMMAND_DEPTH = 3;
const NAMES_A_SECRET_OR_A_PASSWORD_PROGRAM = /passw|passphrase|secret|token|api.?key|auth|bearer|credential|mysql|mariadb|sshpass|redis-cli|curl|wget|:\/\//i;
// Quotes, escapes, substitutions or an undecodable escape left for a level the scan does not read: what they spell stays unknown.
const HOLDS_UNREAD_QUOTING = /[\\'"`�]|\$\(/;

type PasswordProgram = 'mysql' | 'sshpass' | 'redis-cli' | 'curl';

// A word names the program when it is the program, or its path (`/usr/bin/mysql`): `--grep=mysql` only mentions it.
const PASSWORD_PROGRAMS: { kind: PasswordProgram; name: RegExp }[] = [
  // `-p` is a password only for these programs: `mkdir -p`, `cp -p` and `ls -p` are not.
  { kind: 'mysql', name: /^(?:.*\/)?(?:mysql|mysqldump|mysqladmin|mariadb(?:-dump|-admin)?)$/ },
  { kind: 'sshpass', name: /^(?:.*\/)?sshpass$/ },
  { kind: 'redis-cli', name: /^(?:.*\/)?redis-cli$/ },
  { kind: 'curl', name: /^(?:.*\/)?(?:curl|wget)$/ },
];

// Every rule needs one of these: an option's dash, an assignment's `=`, a header's or a URL's colon, or the gap of a nested command.
const MAY_HOLD_A_SECRET = /^-|[=:\s\u0085;&|()]/;
const MENTIONS_A_PASSWORD_PROGRAM = /(?:mysql|mysqldump|mysqladmin|mariadb|-dump|-admin|sshpass|redis-cli|curl|wget)$/;

const ATTACHED_P_PASSWORD = /^-p(?=.)/s;
const ATTACHED_A_PASSWORD = /^-a(?=.)/s;
const CURL_USER_OPTIONS = new Set(['-u', '-U', '--user', '--proxy-user']);
const ATTACHED_CURL_USER = /^(?:-u|-U|--user=|--proxy-user=)(?=.)/s;

/** An option whose value is the next word, and where the secret starts in that value. */
interface ValueTakingOption {
  alwaysTakesAValue: boolean;
  secretStart?: (value: string) => number | undefined;
}

const WHOLE_VALUE = (): number => 0;
const PROGRAM_PASSWORD_OPTION: ValueTakingOption = { alwaysTakesAValue: true };
const CURL_USER_OPTION: ValueTakingOption = { alwaysTakesAValue: true, secretStart: userPasswordStart };

/** Masks the secrets of one command's words; a word holding a command of its own (`sh -c "…"`) is scanned as a command one level deeper. */
class CommandMasking {
  private readonly programsInCommand = new Set<PasswordProgram>();

  constructor(
    private readonly words: ShellWord[],
    private readonly depth: number,
    private readonly toCommandRange: ToCommandRange,
    private readonly masks: SourceRange[],
  ) {}

  run(): void {
    for (let index = 0; index < this.words.length; index += 1) {
      const word = this.words[index]!;
      if (word.startsACommand) this.programsInCommand.clear();
      if (word.isMasked) continue;
      if (MAY_HOLD_A_SECRET.test(word.text)) this.maskWord(index);
      if (!MENTIONS_A_PASSWORD_PROGRAM.test(word.text)) continue;
      for (const program of PASSWORD_PROGRAMS) if (program.name.test(word.text)) this.programsInCommand.add(program.kind);
    }
  }

  private maskCharacters(word: ShellWord, from: number, to: number): void {
    if (from >= to) return;
    this.masks.push(this.toCommandRange(sourceRangeOf(word, from, to)));
  }

  /** Masks a word from `from` to its end; a value that is only a scheme word (`Bearer`) takes the next word along with it. */
  private maskValue(index: number, from: number): void {
    const word = this.words[index]!;
    word.isMasked = true;
    const valueRange = sourceRangeOf(word, from, word.text.length);
    const isASchemeWordAlone = AUTHORIZATION_SCHEME_WORD.test(word.text.slice(from));
    const credential = isASchemeWordAlone ? this.nextInCommand(index) : undefined;
    if (credential === undefined) {
      this.masks.push(this.toCommandRange(valueRange));
      return;
    }
    credential.isMasked = true;
    const credentialRange = sourceRangeOf(credential, 0, credential.text.length);
    this.masks.push(this.toCommandRange({ start: valueRange.start, end: credentialRange.end }));
  }

  private nextInCommand(index: number): ShellWord | undefined {
    const next = this.words[index + 1];
    return next === undefined || next.startsACommand || next.isMasked ? undefined : next;
  }

  /** Masks the word that holds the value of the option at `index`; a dash starts the value of an option that always takes one, and another option otherwise. */
  private maskValueAfter(index: number, option: ValueTakingOption): boolean {
    const value = this.nextInCommand(index);
    if (!value || isAlreadyMasked(value.text)) return false;
    const isAnotherOption = value.text.startsWith('-') && !option.alwaysTakesAValue;
    if (isAnotherOption) return false;
    const secretStart = option.secretStart ?? WHOLE_VALUE;
    const from = secretStart(value.text);
    if (from === NOT_FOUND) return false;
    this.maskValue(index + 1, from);
    return true;
  }

  private maskWord(index: number): void {
    const word = this.words[index]!;
    const isAnOption = word.text.startsWith('-');
    if (isAnOption && (this.maskSecretFlag(index) || this.maskProgramPassword(index))) return;
    const namedSecretStart = assignedSecretStart(word.text) ?? headerCredentialStart(word.text);
    if (namedSecretStart !== NOT_FOUND) {
      this.maskValue(index, namedSecretStart);
      return;
    }
    for (const credentials of urlCredentialRanges(word.text)) this.maskCharacters(word, credentials.start, credentials.end);
    if (holdsSeveralWords(word.text)) this.maskNestedCommand(word);
  }

  /**
   * A word holding a whole command (`sh -c "mysql -p…"`) is masked as a command of its own.
   * Past the depth limit, one that names a secret or a password program, or still holds quoting the scan does not read, is masked whole.
   */
  private maskNestedCommand(word: ShellWord): void {
    const isPastTheDepthLimit = this.depth >= MAX_NESTED_COMMAND_DEPTH;
    if (isPastTheDepthLimit) {
      const mayHideASecret = NAMES_A_SECRET_OR_A_PASSWORD_PROGRAM.test(word.text) || HOLDS_UNREAD_QUOTING.test(word.text);
      if (mayHideASecret) this.maskCharacters(word, 0, word.text.length);
      return;
    }
    const toCommandRange: ToCommandRange = (range) => this.toCommandRange(sourceRangeOf(word, range.start, range.end));
    new CommandMasking(shellWordsOf(word.text), this.depth + 1, toCommandRange, this.masks).run();
  }

  /** `--token VALUE` or `--token=VALUE`; `--authorization=Bearer VALUE` masks the scheme and the word after it. */
  private maskSecretFlag(index: number): boolean {
    const word = this.words[index]!;
    const equalsAt = word.text.indexOf('=');
    const isGivenWithEquals = equalsAt !== -1;
    const flagName = isGivenWithEquals ? word.text.slice(0, equalsAt) : word.text;
    if (!isSecretFlagName(flagName)) return false;
    if (!isGivenWithEquals) return this.maskValueAfter(index, { alwaysTakesAValue: alwaysTakesAValue(flagName) });
    const value = word.text.slice(equalsAt + 1);
    if (value === '' || isAlreadyMasked(value)) return false;
    this.maskValue(index, equalsAt + 1);
    return true;
  }

  private maskProgramPassword(index: number): boolean {
    const word = this.words[index]!;
    const text = word.text;
    const isIn = (program: PasswordProgram) => this.programsInCommand.has(program);
    const maskFrom = (secretStart: number | undefined) => {
      if (secretStart === NOT_FOUND) return false;
      this.maskValue(index, secretStart);
      return true;
    };
    if (isIn('mysql') && maskFrom(attachedValueStart(text, ATTACHED_P_PASSWORD))) return true;
    if (isIn('sshpass') && text === '-p') return this.maskValueAfter(index, PROGRAM_PASSWORD_OPTION);
    if (isIn('sshpass') && maskFrom(attachedValueStart(text, ATTACHED_P_PASSWORD))) return true;
    if (isIn('redis-cli') && text === '-a') return this.maskValueAfter(index, PROGRAM_PASSWORD_OPTION);
    if (isIn('redis-cli') && maskFrom(attachedValueStart(text, ATTACHED_A_PASSWORD))) return true;
    if (isIn('curl') && CURL_USER_OPTIONS.has(text)) return this.maskValueAfter(index, CURL_USER_OPTION);
    const attachedUser = isIn('curl') ? ATTACHED_CURL_USER.exec(text)?.[0] : undefined;
    if (attachedUser === undefined) return false;
    const passwordStart = userPasswordStart(text.slice(attachedUser.length));
    return maskFrom(passwordStart === NOT_FOUND ? NOT_FOUND : attachedUser.length + passwordStart);
  }
}

/** Replaces each masked range of the command by one mask; ranges that overlap or touch become a single mask. */
const withMasksApplied = (command: string, masks: SourceRange[]): string => {
  const ordered = [...masks].sort((first, second) => first.start - second.start);
  let masked = '';
  let copiedUpTo = 0;
  let lastMaskEnd = -1;
  for (const range of ordered) {
    const continuesTheLastMask = range.start <= lastMaskEnd;
    if (!continuesTheLastMask) masked += command.slice(copiedUpTo, range.start) + MASK;
    copiedUpTo = Math.max(copiedUpTo, range.end);
    lastMaskEnd = copiedUpTo;
  }
  return masked + command.slice(copiedUpTo);
};

const sameRange: ToCommandRange = (range) => range;

function maskedWords(command: string): string {
  const masks: SourceRange[] = [];
  new CommandMasking(shellWordsOf(command), 0, sameRange, masks).run();
  return masks.length === 0 ? command : withMasksApplied(command, masks);
}

/**
 * Returns the command with the value of every credential option, assignment, header and URL replaced by a mask.
 * The command is read word by word as the shell reads it (quotes, escaped quotes, glued segments, backslashes), so a value ends where the shell ends it;
 * only the source of the value is replaced, the quotes and words around it stay as written. The scan is linear in the length of the command.
 */
export function maskedCommandSecrets(command: string): string {
  return maskedSecrets(maskedWords(command));
}
