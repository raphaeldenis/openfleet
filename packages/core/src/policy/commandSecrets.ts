import { MASK, maskedSecrets, SECRET_KEY } from '../redact.js';

/** One shell word: its text as written, the text the shell passes to the program once quotes and escapes are read, and the gap before it. */
interface ShellWord {
  raw: string;
  text: string;
  gapBefore: string;
  startsACommand: boolean;
  replacement?: string;
}

const WORD_GAP = /[\s\u0085]/;
const COMMAND_SEPARATORS = new Set([';', '&', '|', '(', ')', '\n', '\r']);
const ESCAPABLE_INSIDE_DOUBLE_QUOTES = new Set(['$', '`', '"', '\\', '\n']);

const endsTheWord = (character: string): boolean => WORD_GAP.test(character) || COMMAND_SEPARATORS.has(character);

type ReadSegment = { text: string; end: number };

/** `'…'`: no escape inside; one that never closes runs to the end of the command. */
const singleQuotedFrom = (command: string, openingAt: number): ReadSegment => {
  const closingAt = command.indexOf("'", openingAt + 1);
  const contentEnd = closingAt === -1 ? command.length : closingAt;
  return { text: command.slice(openingAt + 1, contentEnd), end: closingAt === -1 ? command.length : closingAt + 1 };
};

/** `"…"` (a backslash escapes `"`, `\`, `$`, a backtick and a line break) or `$'…'` (a backslash escapes any character); one that never closes runs to the end of the command. */
const escapedQuotedFrom = (command: string, contentStart: number, quote: string, escapesAnyCharacter: boolean): ReadSegment => {
  let text = '';
  let at = contentStart;
  while (at < command.length) {
    const character = command.charAt(at);
    if (character === quote) return { text, end: at + 1 };
    const nextCharacter = command.charAt(at + 1);
    const isEscape = character === '\\' && at + 1 < command.length && (escapesAnyCharacter || ESCAPABLE_INSIDE_DOUBLE_QUOTES.has(nextCharacter));
    text += isEscape ? nextCharacter : character;
    at += isEscape ? 2 : 1;
  }
  return { text, end: command.length };
};

/** The piece of a word that starts at `at`: an escaped character, a quoted segment or one plain character. */
const segmentAt = (command: string, at: number): ReadSegment => {
  const character = command.charAt(at);
  const nextCharacter = command.charAt(at + 1);
  if (character === '\\') return { text: nextCharacter, end: Math.min(at + 2, command.length) };
  if (character === "'") return singleQuotedFrom(command, at);
  if (character === '"') return escapedQuotedFrom(command, at + 1, '"', false);
  const opensAnsiCQuotes = character === '$' && nextCharacter === "'";
  if (opensAnsiCQuotes) return escapedQuotedFrom(command, at + 2, "'", true);
  return { text: character, end: at + 1 };
};

/** Reads the word that starts at `start`: unquoted runs, quoted segments and escaped characters glued together, as the shell joins them. */
const wordFrom = (command: string, start: number): ReadSegment => {
  let text = '';
  let at = start;
  while (at < command.length && !endsTheWord(command.charAt(at))) {
    const segment = segmentAt(command, at);
    text += segment.text;
    at = segment.end;
  }
  return { text, end: at };
};

/** Splits a command into its words in one pass; a separator (`;`, `&`, `|`, a parenthesis, a line break) in the gap before a word starts a new command. */
const shellWordsOf = (command: string): { words: ShellWord[]; trailingGap: string } => {
  const words: ShellWord[] = [];
  let at = 0;
  while (at < command.length) {
    const gapStart = at;
    let holdsASeparator = false;
    while (at < command.length && endsTheWord(command.charAt(at))) {
      holdsASeparator ||= COMMAND_SEPARATORS.has(command.charAt(at));
      at += 1;
    }
    if (at >= command.length) return { words, trailingGap: command.slice(gapStart) };
    const word = wordFrom(command, at);
    words.push({ raw: command.slice(at, word.end), text: word.text, gapBefore: command.slice(gapStart, at), startsACommand: words.length === 0 || holdsASeparator });
    at = word.end;
  }
  return { words, trailingGap: '' };
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

const SECRET_IN_VARIABLE_NAME = /password|passwd|passphrase|secret|token|api_?key|auth|bearer|credential/i;
const VARIABLE_NAME_CHARACTER = /[A-Za-z0-9_]/;
const AUTHORIZATION_SCHEME_WORD = /^(?:bearer|basic|token)$/i;
const HEADER_NAME_AND_COLON = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*/;
const AUTHORIZATION_SCHEME_PREFIX = /^(?:bearer|basic|token)[ \t]+/i;
const URL_AUTHORITY_END = /[\s/?#]/;
const ALREADY_MASKED_VALUE = /^\*\*\*["'}\],]*$/;

const isAlreadyMasked = (value: string): boolean => ALREADY_MASKED_VALUE.test(value);

/** `API_KEY=…`, `-eDB_PASSWORD=…`, `user=x&token=…`: everything after the first `=` that closes a name holding a secret word is the secret. */
const maskedAssignment = (text: string): string | undefined => {
  for (let equalsAt = text.indexOf('='); equalsAt !== -1; equalsAt = text.indexOf('=', equalsAt + 1)) {
    let nameStart = equalsAt;
    while (nameStart > 0 && VARIABLE_NAME_CHARACTER.test(text.charAt(nameStart - 1))) nameStart -= 1;
    const value = text.slice(equalsAt + 1);
    const namesASecret = SECRET_IN_VARIABLE_NAME.test(text.slice(nameStart, equalsAt));
    if (namesASecret && value !== '' && !isAlreadyMasked(value)) return text.slice(0, equalsAt + 1) + MASK;
  }
  return undefined;
};

/** `Authorization: Bearer …`, `X-Api-Key: …`: the value of a header named after a credential, its scheme word kept readable. */
const maskedHeader = (text: string): string | undefined => {
  const header = HEADER_NAME_AND_COLON.exec(text);
  if (!header) return undefined;
  const [prefix = '', name = ''] = header;
  const namesASecret = SECRET_KEY.test(name) || SECRET_IN_VARIABLE_NAME.test(name);
  const value = text.slice(prefix.length);
  const scheme = AUTHORIZATION_SCHEME_PREFIX.exec(value)?.[0] ?? '';
  const credential = value.slice(scheme.length);
  if (!namesASecret || credential === '' || isAlreadyMasked(credential)) return undefined;
  return prefix + scheme + MASK;
};

/** `scheme://user:password@host`: the credentials end at the last `@` before the host ends (a password may hold an `@`, never a `/`). */
const maskedUrlCredentials = (text: string): string => {
  let masked = '';
  let copiedUpTo = 0;
  for (let schemeEnd = text.indexOf('://'); schemeEnd !== -1; schemeEnd = text.indexOf('://', copiedUpTo)) {
    const authorityStart = schemeEnd + 3;
    let authorityEnd = authorityStart;
    let lastAtSign = -1;
    while (authorityEnd < text.length && !URL_AUTHORITY_END.test(text.charAt(authorityEnd))) {
      if (text.charAt(authorityEnd) === '@') lastAtSign = authorityEnd;
      authorityEnd += 1;
    }
    const credentials = lastAtSign === -1 ? '' : text.slice(authorityStart, lastAtSign);
    const holdsCredentials = credentials !== '' && credentials !== MASK;
    masked += holdsCredentials ? text.slice(copiedUpTo, authorityStart) + MASK : text.slice(copiedUpTo, authorityEnd);
    copiedUpTo = holdsCredentials ? lastAtSign : authorityEnd;
  }
  return masked + text.slice(copiedUpTo);
};

const MAX_NESTED_COMMAND_DEPTH = 3;
const NAMES_A_SECRET_OR_A_PASSWORD_PROGRAM = /passw|passphrase|secret|token|api.?key|auth|bearer|credential|mysql|mariadb|sshpass|redis-cli|curl|wget|:\/\//i;

/** A word holding a whole command (`sh -c "mysql -p…"`, a JSON string) is masked as a command of its own; past the depth limit, one that names a secret is masked whole. */
const maskedWordText = (text: string, depth: number): string => {
  const withoutUrlCredentials = maskedUrlCredentials(text);
  const holdsSeveralWords = WORD_GAP.test(withoutUrlCredentials) || [...COMMAND_SEPARATORS].some((separator) => withoutUrlCredentials.includes(separator));
  if (!holdsSeveralWords) return withoutUrlCredentials;
  const isPastTheDepthLimit = depth >= MAX_NESTED_COMMAND_DEPTH;
  if (!isPastTheDepthLimit) return maskedWords(withoutUrlCredentials, depth + 1);
  return NAMES_A_SECRET_OR_A_PASSWORD_PROGRAM.test(withoutUrlCredentials) ? MASK : withoutUrlCredentials;
};

type PasswordProgram = 'mysql' | 'sshpass' | 'redis-cli' | 'curl';

const PASSWORD_PROGRAMS: { kind: PasswordProgram; name: RegExp }[] = [
  // `-p` is a password only for these programs: `mkdir -p`, `cp -p` and `ls -p` are not.
  { kind: 'mysql', name: /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/ },
  { kind: 'sshpass', name: /\bsshpass\b/ },
  { kind: 'redis-cli', name: /\bredis-cli\b/ },
  { kind: 'curl', name: /\b(?:curl|wget)\b/ },
];

const ATTACHED_P_PASSWORD = /^-p(?=.)/s;
const ATTACHED_A_PASSWORD = /^-a(?=.)/s;
const CURL_USER_OPTIONS = new Set(['-u', '-U', '--user', '--proxy-user']);
const ATTACHED_CURL_USER = /^(?:-u|-U|--user=|--proxy-user=)(?=.)/s;

/** `alice:password` → `alice:***`; a user without a password stays readable (the program prompts for it). */
const maskedUserPassword = (userAndPassword: string): string | undefined => {
  const colonAt = userAndPassword.indexOf(':');
  const password = colonAt === -1 ? '' : userAndPassword.slice(colonAt + 1);
  if (password === '' || isAlreadyMasked(password)) return undefined;
  return userAndPassword.slice(0, colonAt + 1) + MASK;
};

const attachedValueMasked = (text: string, optionPrefix: RegExp): string | undefined => {
  const prefix = optionPrefix.exec(text)?.[0];
  if (prefix === undefined) return undefined;
  const value = text.slice(prefix.length);
  return isAlreadyMasked(value) ? undefined : prefix + MASK;
};

/** The quotes of a word whose inside a rule rewrote: the opening quote it was written with, so `"Authorization: Bearer ***"` keeps its look. */
const rewrittenWord = (word: ShellWord, text: string): string => {
  const openingQuote = word.raw.startsWith('"') || word.raw.startsWith("'") ? word.raw.charAt(0) : '';
  return `${openingQuote}${text}${openingQuote}`;
};

class CommandMasking {
  private readonly programsInCommand = new Set<PasswordProgram>();

  constructor(private readonly words: ShellWord[], private readonly depth: number) {}

  run(): void {
    for (let index = 0; index < this.words.length; index += 1) {
      const word = this.words[index]!;
      if (word.startsACommand) this.programsInCommand.clear();
      if (word.replacement !== undefined) continue;
      this.maskWord(index);
      for (const program of PASSWORD_PROGRAMS) if (program.name.test(word.text)) this.programsInCommand.add(program.kind);
    }
  }

  private nextInCommand(index: number): ShellWord | undefined {
    const next = this.words[index + 1];
    return next === undefined || next.startsACommand || next.replacement !== undefined ? undefined : next;
  }

  /** Masks the word that holds the value of the option at `index`; a lone scheme word (`Bearer`) takes the next word along with it. */
  private maskValueAfter(index: number, masked: (value: string) => string | undefined = () => MASK): boolean {
    const value = this.nextInCommand(index);
    if (!value || value.raw.startsWith('-') || isAlreadyMasked(value.text)) return false;
    const maskedValue = masked(value.text);
    if (maskedValue === undefined) return false;
    value.replacement = maskedValue === MASK ? MASK : rewrittenWord(value, maskedValue);
    if (AUTHORIZATION_SCHEME_WORD.test(value.text)) this.swallowNextWord(index + 1);
    return true;
  }

  private swallowNextWord(index: number): void {
    const credential = this.nextInCommand(index);
    if (!credential) return;
    credential.gapBefore = '';
    credential.replacement = '';
  }

  private maskWord(index: number): void {
    if (this.maskSecretFlag(index) || this.maskProgramPassword(index)) return;
    const word = this.words[index]!;
    const withoutNamedSecret = maskedAssignment(word.text) ?? maskedHeader(word.text) ?? word.text;
    const fullyMasked = maskedWordText(withoutNamedSecret, this.depth);
    if (fullyMasked !== word.text) word.replacement = rewrittenWord(word, fullyMasked);
  }

  /** `--token VALUE` or `--token=VALUE`; `--authorization=Bearer VALUE` masks the scheme and the word after it. */
  private maskSecretFlag(index: number): boolean {
    const word = this.words[index]!;
    const equalsAt = word.text.indexOf('=');
    const isGivenWithEquals = equalsAt !== -1;
    const flagName = isGivenWithEquals ? word.text.slice(0, equalsAt) : word.text;
    if (!isSecretFlagName(flagName)) return false;
    if (!isGivenWithEquals) return this.maskValueAfter(index);
    const value = word.text.slice(equalsAt + 1);
    if (value === '' || isAlreadyMasked(value)) return false;
    word.replacement = rewrittenWord(word, word.text.slice(0, equalsAt + 1) + MASK);
    if (AUTHORIZATION_SCHEME_WORD.test(value)) this.swallowNextWord(index);
    return true;
  }

  private maskProgramPassword(index: number): boolean {
    const word = this.words[index]!;
    const text = word.text;
    const isIn = (program: PasswordProgram) => this.programsInCommand.has(program);
    const rewrite = (masked: string | undefined) => {
      if (masked === undefined) return false;
      word.replacement = rewrittenWord(word, masked);
      return true;
    };
    if (isIn('mysql') && rewrite(attachedValueMasked(text, ATTACHED_P_PASSWORD))) return true;
    if (isIn('sshpass') && text === '-p') return this.maskValueAfter(index);
    if (isIn('sshpass') && rewrite(attachedValueMasked(text, ATTACHED_P_PASSWORD))) return true;
    if (isIn('redis-cli') && text === '-a') return this.maskValueAfter(index);
    if (isIn('redis-cli') && rewrite(attachedValueMasked(text, ATTACHED_A_PASSWORD))) return true;
    if (isIn('curl') && CURL_USER_OPTIONS.has(text)) return this.maskValueAfter(index, maskedUserPassword);
    const attachedUser = isIn('curl') ? ATTACHED_CURL_USER.exec(text)?.[0] : undefined;
    if (attachedUser === undefined) return false;
    const maskedUser = maskedUserPassword(text.slice(attachedUser.length));
    return rewrite(maskedUser === undefined ? undefined : attachedUser + maskedUser);
  }
}

function maskedWords(command: string, depth: number): string {
  const { words, trailingGap } = shellWordsOf(command);
  new CommandMasking(words, depth).run();
  const isUnchanged = words.every((word) => word.replacement === undefined);
  if (isUnchanged) return command;
  return words.map((word) => word.gapBefore + (word.replacement ?? word.raw)).join('') + trailingGap;
}

/**
 * Returns the command with the value of every credential option, assignment, header and URL replaced by a mask.
 * The command is read word by word as the shell reads it (quotes, escaped quotes, glued segments, backslashes), so a value ends where the shell ends it; the scan is linear in the length of the command.
 */
export function maskedCommandSecrets(command: string): string {
  return maskedSecrets(maskedWords(command, 0));
}
