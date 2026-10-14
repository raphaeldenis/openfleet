export type ControlOperator = ';' | '&&' | '||' | '|' | '|&' | '&' | '\n' | '(' | ')';
export type RedirectOperator = '>' | '>>' | '>|' | '&>' | '&>>' | '<' | '<<' | '<<<' | '>&' | '<&' | '<>';

export interface HeredocBody { body: string; expandsSubstitutions: boolean }

export interface WordToken { kind: 'word'; text: string; isQuoted: boolean; substitutions: string[] }
export interface OperatorToken { kind: 'operator'; operator: ControlOperator }
export interface RedirectToken { kind: 'redirect'; operator: RedirectOperator; fd?: number; heredoc?: HeredocBody }
export type ShellToken = WordToken | OperatorToken | RedirectToken;

export interface ScanResult { tokens: ShellToken[]; isPartial: boolean }
export interface SubstitutionScan { scripts: string[]; isPartial: boolean }

type NestingFrame = 'paren' | 'brace' | 'double';
interface PendingHeredoc { token: RedirectToken; delimiter: string; expandsSubstitutions: boolean; stripsTabs: boolean }
interface WordUnderConstruction { isStarted: boolean; isQuoted: boolean; text: string; substitutions: string[] }

const REDIRECT_OPERATORS_LONGEST_FIRST = ['<<<', '<<-', '&>>', '>>', '>|', '>&', '<<', '<&', '<>', '&>', '>', '<'] as const;
const DOUBLE_QUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\']);
const ANSI_SIMPLE_ESCAPES = new Map([
  ['n', '\n'], ['t', '\t'], ['r', '\r'], ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['f', '\f'], ['v', '\v'],
  ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'],
]);
const BLANK_CHARACTERS = new Set([' ', '\t', '\r']);
const CONTROL_CHARACTERS = new Set([';', '&', '|', '(', ')']);

const isDigits = (text: string): boolean => text.length > 0 && [...text].every((character) => character >= '0' && character <= '9');
const isOctalDigit = (character: string | undefined): boolean => character !== undefined && character >= '0' && character <= '7';
const isHexDigit = (character: string | undefined): boolean => character !== undefined && /^[0-9a-fA-F]$/.test(character);

/** Returns the index of the backtick that closes the one opening at `openIndex`, or -1. */
function findClosingBacktick(source: string, openIndex: number): number {
  let index = openIndex + 1;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source[index] === '`') return index;
    else index += 1;
  }
  return -1;
}

const unescapeBackticks = (script: string): string => script.replace(/\\([`\\$])/g, '$1');

/**
 * Returns the index of the delimiter closing a `$(` or `${` whose content starts at `from`, or -1 when it never closes.
 * One pass with an explicit stack: quotes and nested substitutions are skipped, and nothing recurses.
 */
export function findClosingIndex(source: string, from: number, opener: 'paren' | 'brace'): number {
  const frames: NestingFrame[] = [opener];
  let index = from;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    const innermost = frames[frames.length - 1];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '`') {
      const closing = findClosingBacktick(source, index);
      if (closing === -1) return -1;
      index = closing + 1;
      continue;
    }
    if (character === '$' && next === '(') {
      frames.push('paren');
      index += 2;
      continue;
    }
    if (character === '$' && next === '{') {
      frames.push('brace');
      index += 2;
      continue;
    }
    if (innermost === 'double') {
      if (character === '"') frames.pop();
      index += 1;
      continue;
    }
    if (character === "'") {
      const closing = source.indexOf("'", index + 1);
      if (closing === -1) return -1;
      index = closing + 1;
      continue;
    }
    if (character === '"') frames.push('double');
    else if (character === '(' && innermost === 'paren') frames.push('paren');
    else if ((character === ')' && innermost === 'paren') || (character === '}' && innermost === 'brace')) {
      frames.pop();
      if (frames.length === 0) return index;
    }
    index += 1;
  }
  return -1;
}

const isArithmetic = (inner: string): boolean => inner.startsWith('(') && inner.endsWith(')');

/** Lists the scripts run by `$(…)` and backtick substitutions found in text that is not itself parsed as shell (a heredoc body, a `${…}` expansion). */
export function substitutionScriptsOf(text: string): SubstitutionScan {
  const scripts: string[] = [];
  let isPartial = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
    } else if (character === '`') {
      const closing = findClosingBacktick(text, index);
      isPartial = isPartial || closing === -1;
      const end = closing === -1 ? text.length : closing;
      scripts.push(unescapeBackticks(text.slice(index + 1, end)));
      index = end + 1;
    } else if (character === '$' && text[index + 1] === '(') {
      const closing = findClosingIndex(text, index + 2, 'paren');
      isPartial = isPartial || closing === -1;
      const end = closing === -1 ? text.length : closing;
      const inner = text.slice(index + 2, end);
      if (!isArithmetic(inner)) scripts.push(inner);
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return { scripts, isPartial };
}

function decodeAnsiEscape(source: string, backslashIndex: number): { text: string; consumed: number } {
  const escaped = source[backslashIndex + 1];
  if (escaped === undefined) return { text: '\\', consumed: 1 };
  const simple = ANSI_SIMPLE_ESCAPES.get(escaped);
  if (simple !== undefined) return { text: simple, consumed: 2 };
  if (escaped === 'x' || escaped === 'u') {
    const maxDigits = escaped === 'x' ? 2 : 4;
    let digits = '';
    while (digits.length < maxDigits && isHexDigit(source[backslashIndex + 2 + digits.length])) digits += source[backslashIndex + 2 + digits.length];
    if (digits.length > 0) return { text: String.fromCodePoint(parseInt(digits, 16)), consumed: 2 + digits.length };
  }
  if (isOctalDigit(escaped)) {
    let digits = '';
    while (digits.length < 3 && isOctalDigit(source[backslashIndex + 1 + digits.length])) digits += source[backslashIndex + 1 + digits.length];
    return { text: String.fromCodePoint(parseInt(digits, 8)), consumed: 1 + digits.length };
  }
  return { text: `\\${escaped}`, consumed: 2 };
}

class ShellScanner {
  private position = 0;
  private isPartial = false;
  private readonly tokens: ShellToken[] = [];
  private readonly pendingHeredocs: PendingHeredoc[] = [];
  private heredocAwaitingDelimiter: { token: RedirectToken; stripsTabs: boolean } | undefined;
  private word: WordUnderConstruction = ShellScanner.emptyWord();

  constructor(private readonly source: string) {}

  scan(): ScanResult {
    while (this.position < this.source.length) this.scanNext();
    this.endWord();
    const hasUnreadHeredoc = this.pendingHeredocs.length > 0 || this.heredocAwaitingDelimiter !== undefined;
    return { tokens: this.tokens, isPartial: this.isPartial || hasUnreadHeredoc };
  }

  private static emptyWord(): WordUnderConstruction {
    return { isStarted: false, isQuoted: false, text: '', substitutions: [] };
  }

  private get character(): string {
    return this.source[this.position] as string;
  }

  private scanNext(): void {
    const character = this.character;
    const isCommentStart = character === '#' && !this.word.isStarted;
    if (BLANK_CHARACTERS.has(character)) this.skipBlank();
    else if (character === '\n') this.scanNewline();
    else if (isCommentStart) this.skipComment();
    else if (this.redirectOperatorAt(this.position) !== undefined && !this.isProcessSubstitutionAt(this.position)) this.scanRedirect();
    else if (CONTROL_CHARACTERS.has(character)) this.scanControl();
    else this.scanWordPart();
  }

  private skipBlank(): void {
    this.endWord();
    this.position += 1;
  }

  private skipComment(): void {
    const lineEnd = this.source.indexOf('\n', this.position);
    this.position = lineEnd === -1 ? this.source.length : lineEnd;
  }

  private scanNewline(): void {
    this.endWord();
    this.tokens.push({ kind: 'operator', operator: '\n' });
    this.position += 1;
    this.readPendingHeredocBodies();
  }

  private scanControl(): void {
    this.endWord();
    const doubled = this.source.slice(this.position, this.position + 2);
    const operator: ControlOperator = (['&&', '||', '|&'] as const).find((candidate) => candidate === doubled) ?? (this.character as ControlOperator);
    this.tokens.push({ kind: 'operator', operator });
    this.position += operator.length;
  }

  private redirectOperatorAt(position: number): (typeof REDIRECT_OPERATORS_LONGEST_FIRST)[number] | undefined {
    return REDIRECT_OPERATORS_LONGEST_FIRST.find((operator) => this.source.startsWith(operator, position));
  }

  private isProcessSubstitutionAt(position: number): boolean {
    const isAngle = this.source[position] === '<' || this.source[position] === '>';
    return isAngle && this.source[position + 1] === '(';
  }

  private scanRedirect(): void {
    const matched = this.redirectOperatorAt(this.position) as (typeof REDIRECT_OPERATORS_LONGEST_FIRST)[number];
    const fd = matched.startsWith('&') ? undefined : this.takeFileDescriptorPrefix();
    if (fd === undefined) this.endWord();
    const stripsTabs = matched === '<<-';
    const operator = (stripsTabs ? '<<' : matched) as RedirectOperator;
    const token: RedirectToken = fd === undefined ? { kind: 'redirect', operator } : { kind: 'redirect', operator, fd };
    this.tokens.push(token);
    this.position += matched.length;
    if (operator === '<<') this.heredocAwaitingDelimiter = { token, stripsTabs };
  }

  private takeFileDescriptorPrefix(): number | undefined {
    const { isStarted, isQuoted, text, substitutions } = this.word;
    const isPlainNumber = isStarted && !isQuoted && substitutions.length === 0 && isDigits(text);
    if (!isPlainNumber) return undefined;
    this.word = ShellScanner.emptyWord();
    return Number(text);
  }

  private startWord(): void {
    this.word.isStarted = true;
  }

  private append(text: string): void {
    this.startWord();
    this.word.text += text;
  }

  private endWord(): void {
    if (!this.word.isStarted) return;
    const { text, isQuoted, substitutions } = this.word;
    this.tokens.push({ kind: 'word', text, isQuoted, substitutions });
    this.registerHeredocDelimiter(text, isQuoted);
    this.word = ShellScanner.emptyWord();
  }

  private registerHeredocDelimiter(delimiter: string, isQuoted: boolean): void {
    if (this.heredocAwaitingDelimiter === undefined) return;
    const { token, stripsTabs } = this.heredocAwaitingDelimiter;
    this.pendingHeredocs.push({ token, delimiter, expandsSubstitutions: !isQuoted, stripsTabs });
    this.heredocAwaitingDelimiter = undefined;
  }

  private readPendingHeredocBodies(): void {
    for (const pending of this.pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      let isTerminated = false;
      while (this.position < this.source.length && !isTerminated) {
        const lineEnd = this.source.indexOf('\n', this.position);
        const end = lineEnd === -1 ? this.source.length : lineEnd;
        const line = this.source.slice(this.position, end);
        this.position = lineEnd === -1 ? this.source.length : lineEnd + 1;
        const comparable = pending.stripsTabs ? line.replace(/^\t+/, '') : line;
        isTerminated = comparable === pending.delimiter;
        if (!isTerminated) lines.push(line);
      }
      if (!isTerminated) this.isPartial = true;
      pending.token.heredoc = { body: lines.join('\n'), expandsSubstitutions: pending.expandsSubstitutions };
    }
  }

  private scanWordPart(): void {
    const character = this.character;
    if (character === "'") this.readSingleQuoted();
    else if (character === '"') this.readDoubleQuoted();
    else if (character === '\\') this.readEscape();
    else if (character === '`') this.readBackticks();
    else if (character === '$') this.readDollar({ insideDoubleQuotes: false });
    else if (this.isProcessSubstitutionAt(this.position)) this.readProcessSubstitution();
    else {
      this.append(character);
      this.position += 1;
    }
  }

  private markQuoted(): void {
    this.startWord();
    this.word.isQuoted = true;
  }

  private readSingleQuoted(): void {
    this.markQuoted();
    const closing = this.source.indexOf("'", this.position + 1);
    const end = closing === -1 ? this.source.length : closing;
    this.isPartial = this.isPartial || closing === -1;
    this.word.text += this.source.slice(this.position + 1, end);
    this.position = end + 1;
  }

  private readDoubleQuoted(): void {
    this.markQuoted();
    this.position += 1;
    while (this.position < this.source.length) {
      const character = this.character;
      if (character === '"') {
        this.position += 1;
        return;
      }
      if (character === '\\') this.readDoubleQuotedEscape();
      else if (character === '`') this.readBackticks();
      else if (character === '$') this.readDollar({ insideDoubleQuotes: true });
      else {
        this.word.text += character;
        this.position += 1;
      }
    }
    this.isPartial = true;
  }

  private readDoubleQuotedEscape(): void {
    const escaped = this.source[this.position + 1];
    if (escaped !== undefined && DOUBLE_QUOTE_ESCAPABLE.has(escaped)) {
      this.word.text += escaped;
      this.position += 2;
    } else if (escaped === '\n') {
      this.position += 2;
    } else {
      this.word.text += '\\';
      this.position += 1;
    }
  }

  private readEscape(): void {
    const escaped = this.source[this.position + 1];
    this.position += 2;
    if (escaped === '\n') return;
    this.markQuoted();
    this.word.text += escaped ?? '\\';
  }

  private readBackticks(): void {
    const closing = findClosingBacktick(this.source, this.position);
    const end = closing === -1 ? this.source.length : closing;
    this.isPartial = this.isPartial || closing === -1;
    this.addSubstitution({ raw: this.source.slice(this.position, end + 1), script: unescapeBackticks(this.source.slice(this.position + 1, end)) });
    this.position = end + 1;
  }

  private readDollar({ insideDoubleQuotes }: { insideDoubleQuotes: boolean }): void {
    const next = this.source[this.position + 1];
    if (next === '(') this.readDollarParenthesis();
    else if (next === '{') this.readParameterExpansion();
    else if (next === "'" && !insideDoubleQuotes) this.readAnsiCQuoted();
    else if (next === '"' && !insideDoubleQuotes) this.position += 1;
    else {
      this.append('$');
      this.position += 1;
    }
  }

  private readDollarParenthesis(): void {
    const closing = findClosingIndex(this.source, this.position + 2, 'paren');
    const end = closing === -1 ? this.source.length : closing;
    this.isPartial = this.isPartial || closing === -1;
    const inner = this.source.slice(this.position + 2, end);
    const raw = this.source.slice(this.position, end + 1);
    if (isArithmetic(inner)) this.append(raw);
    else this.addSubstitution({ raw, script: inner });
    this.position = end + 1;
  }

  private readParameterExpansion(): void {
    const closing = findClosingIndex(this.source, this.position + 2, 'brace');
    const end = closing === -1 ? this.source.length : closing;
    this.isPartial = this.isPartial || closing === -1;
    this.append(this.source.slice(this.position, end + 1));
    const nested = substitutionScriptsOf(this.source.slice(this.position + 2, end));
    this.word.substitutions.push(...nested.scripts);
    this.position = end + 1;
  }

  private readProcessSubstitution(): void {
    const closing = findClosingIndex(this.source, this.position + 2, 'paren');
    const end = closing === -1 ? this.source.length : closing;
    this.isPartial = this.isPartial || closing === -1;
    this.addSubstitution({ raw: this.source.slice(this.position, end + 1), script: this.source.slice(this.position + 2, end) });
    this.position = end + 1;
  }

  private readAnsiCQuoted(): void {
    this.markQuoted();
    this.position += 2;
    while (this.position < this.source.length) {
      const character = this.character;
      if (character === "'") {
        this.position += 1;
        return;
      }
      if (character === '\\') {
        const decoded = decodeAnsiEscape(this.source, this.position);
        this.word.text += decoded.text;
        this.position += decoded.consumed;
      } else {
        this.word.text += character;
        this.position += 1;
      }
    }
    this.isPartial = true;
  }

  private addSubstitution({ raw, script }: { raw: string; script: string }): void {
    this.append(raw);
    this.word.substitutions.push(script);
  }
}

/** Splits shell text into words, operators and redirections. Never throws, and reads the text in a single pass. */
export function scanShell(source: string): ScanResult {
  return new ShellScanner(source).scan();
}
