import { VIEW_CONFIG_FIELDS, type ViewConfigContent } from '@openfleet/shared';

export const MAX_JQL_CHARS = 500;
export const MAX_JQL_CLAUSES = 8;
export const MAX_LIST_VALUES = 20;
export const MAX_VALUE_CHARS = 100;

type FieldKind = 'name' | 'person' | 'date';

const FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  project: 'name', status: 'name', priority: 'name', issuetype: 'name', resolution: 'name', labels: 'name', component: 'name', fixVersion: 'name',
  assignee: 'person', reporter: 'person',
  created: 'date', updated: 'date',
};
const CANONICAL_FIELD_NAME = new Map(Object.keys(FIELD_KINDS).map((name) => [name.toLowerCase(), name]));
const ORDER_FIELDS = new Map(['updated', 'created', 'priority', 'status'].map((name) => [name.toLowerCase(), name]));

const EQUALITY_OPERATORS = ['=', '!='];
const COMPARISON_OPERATORS = ['>', '>=', '<', '<='];
const BARE_VALUE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const RELATIVE_DATE = /^-\d{1,3}[mhdw]$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

type Token = { kind: 'string' | 'word' | 'operator' | 'open' | 'close' | 'comma'; text: string };

/** The reason a query is refused. It names a rule, never the text that broke it. */
class Refusal extends Error {}

const refuse = (reason: string): never => { throw new Refusal(reason); };

const TOKEN_PATTERNS: { kind: Token['kind']; pattern: RegExp }[] = [
  { kind: 'operator', pattern: /^(!=|>=|<=|=|>|<)/ },
  { kind: 'open', pattern: /^\(/ },
  { kind: 'close', pattern: /^\)/ },
  { kind: 'comma', pattern: /^,/ },
  { kind: 'word', pattern: /^[A-Za-z0-9_.-]+/ },
];

/** Reads a double-quoted string whose only escapes are `\"` and `\\`; returns its value and the text after the closing quote. */
const readString = (text: string): { value: string; rest: string } => {
  let value = '';
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') return { value, rest: text.slice(index + 1) };
    if (CONTROL_CHARACTER.test(character)) return refuse('a value holds a control character.');
    if (character !== '\\') { value += character; continue; }
    const escaped = text[index + 1];
    const isKnownEscape = escaped === '"' || escaped === '\\';
    if (!isKnownEscape) return refuse('a string escapes something other than a quote or a backslash.');
    value += escaped;
    index += 1;
  }
  return refuse('a string is not closed.');
};

const tokensOf = (jql: string): Token[] => {
  const tokens: Token[] = [];
  let rest = jql.trimStart();
  while (rest.length > 0) {
    if (rest.startsWith('"')) {
      const string = readString(rest);
      tokens.push({ kind: 'string', text: string.value });
      rest = string.rest.trimStart();
      continue;
    }
    const matched = TOKEN_PATTERNS.map(({ kind, pattern }) => ({ kind, match: pattern.exec(rest) })).find(({ match }) => match !== null);
    if (matched === undefined) return refuse('the query holds a character that is not allowed.');
    const text = matched.match![0];
    tokens.push({ kind: matched.kind, text });
    rest = rest.slice(text.length).trimStart();
  }
  return tokens;
};

const isWord = (token: Token | undefined, word: string): boolean => token?.kind === 'word' && token.text.toUpperCase() === word;

const quoted = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

class QueryReader {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.position]; }

  private take(): Token { const token = this.peek(); if (token === undefined) return refuse('the query ends too soon.'); this.position += 1; return token; }

  private takeKind(kind: Token['kind'], reason: string): Token { const token = this.take(); return token.kind === kind ? token : refuse(reason); }

  /** The clauses joined by AND, then an optional ORDER BY, rebuilt from their parts. */
  query(): string {
    const clauses = [this.clause()];
    while (isWord(this.peek(), 'AND')) {
      this.take();
      clauses.push(this.clause());
      if (clauses.length > MAX_JQL_CLAUSES) refuse(`a query holds at most ${MAX_JQL_CLAUSES} clauses.`);
    }
    const order = isWord(this.peek(), 'ORDER') ? this.orderBy() : undefined;
    if (this.peek() !== undefined) refuse('the query holds something after its last clause that is not allowed.');
    return [clauses.join(' AND '), ...(order === undefined ? [] : [order])].join(' ');
  }

  private clause(): string {
    const fieldToken = this.takeKind('word', 'a clause starts with a field.');
    const field = CANONICAL_FIELD_NAME.get(fieldToken.text.toLowerCase());
    if (field === undefined) return refuse('a clause names a field that is not allowed.');
    const kind = FIELD_KINDS[field]!;
    const operator = this.operator(kind);
    const isList = operator === 'IN' || operator === 'NOT IN';
    const value = isList ? this.list(kind) : this.value(kind);
    return `${field} ${operator} ${value}`;
  }

  private operator(kind: FieldKind): string {
    const token = this.take();
    if (isWord(token, 'IN')) return kind === 'date' ? refuse('a date is compared, not listed.') : 'IN';
    if (isWord(token, 'NOT')) {
      const isNotIn = isWord(this.take(), 'IN');
      return isNotIn && kind !== 'date' ? 'NOT IN' : refuse('NOT is allowed before IN only.');
    }
    const allowed = kind === 'date' ? COMPARISON_OPERATORS : EQUALITY_OPERATORS;
    return token.kind === 'operator' && allowed.includes(token.text) ? token.text : refuse('an operator is not allowed for its field.');
  }

  private list(kind: FieldKind): string {
    this.takeKind('open', 'a list opens with a parenthesis.');
    const values = [this.value(kind)];
    while (this.peek()?.kind === 'comma') {
      this.take();
      values.push(this.value(kind));
      if (values.length > MAX_LIST_VALUES) refuse(`a list holds at most ${MAX_LIST_VALUES} values.`);
    }
    this.takeKind('close', 'a list closes with a parenthesis.');
    return `(${values.join(', ')})`;
  }

  private value(kind: FieldKind): string {
    const token = this.take();
    if (kind === 'date') return dateValueOf(token);
    if (token.kind === 'string') return textValueOf(token.text);
    if (token.kind !== 'word') return refuse('a value is expected.');
    if (token.text.toLowerCase() === 'currentuser') return this.currentUser(kind);
    if (token.text.toUpperCase() === 'EMPTY') return 'EMPTY';
    return BARE_VALUE.test(token.text) ? textValueOf(token.text) : refuse('a value is not allowed.');
  }

  private currentUser(kind: FieldKind): string {
    if (kind !== 'person') return refuse('currentUser() is allowed for a person field only.');
    this.takeKind('open', 'currentUser takes no argument.');
    this.takeKind('close', 'currentUser takes no argument.');
    return 'currentUser()';
  }

  private orderBy(): string {
    this.take();
    if (!isWord(this.take(), 'BY')) return refuse('ORDER is followed by BY.');
    const fieldToken = this.takeKind('word', 'ORDER BY names a field.');
    const field = ORDER_FIELDS.get(fieldToken.text.toLowerCase());
    if (field === undefined) return refuse('ORDER BY names a field that is not allowed.');
    const direction = isWord(this.peek(), 'ASC') || isWord(this.peek(), 'DESC') ? this.take().text.toUpperCase() : undefined;
    return `ORDER BY ${field}${direction === undefined ? '' : ` ${direction}`}`;
  }
}

const textValueOf = (text: string): string => {
  const isUsable = text.length > 0 && text.length <= MAX_VALUE_CHARS;
  return isUsable ? quoted(text) : refuse(`a value holds between 1 and ${MAX_VALUE_CHARS} characters.`);
};

const dateValueOf = (token: Token): string => {
  const isRelative = token.kind === 'word' && RELATIVE_DATE.test(token.text);
  if (isRelative) return token.text;
  const isIsoDate = (token.kind === 'word' || token.kind === 'string') && ISO_DATE.test(token.text);
  return isIsoDate ? quoted(token.text) : refuse('a date is a relative date like -7d or a day like 2026-11-09.');
};

const fieldsOf = (requested: readonly string[]): string[] => {
  const isKnown = requested.every((field) => (VIEW_CONFIG_FIELDS as readonly string[]).includes(field));
  if (!isKnown) return refuse('a displayed field is not allowed.');
  const kept = VIEW_CONFIG_FIELDS.filter((field) => requested.includes(field));
  const showsTheSummary = kept.includes('summary');
  return showsTheSummary ? kept : refuse('the displayed fields include the summary.');
};

export type ViewConfigCheck = { ok: true; config: ViewConfigContent } | { ok: false; issues: string[] };

/**
 * Checks a view configuration without any effect and rebuilds it in its canonical form.
 * The JQL is read against a short allow list (a few fields, the operators `=` `!=` `IN` `NOT IN`, comparisons on dates, AND, one ORDER BY, `currentUser()` and `EMPTY`)
 * and written back from its parts with every value quoted and escaped, so the text that is approved, stored and sent is never the text that was typed.
 * Both the typed text and the canonical form hold at most `MAX_JQL_CHARS`, so the canonical form always passes this check again unchanged.
 */
export const checkViewConfig = (input: { jql: string; fields: readonly string[] }): ViewConfigCheck => {
  try {
    const isTypedTextTooLong = input.jql.length > MAX_JQL_CHARS;
    if (isTypedTextTooLong) refuse(`a query holds at most ${MAX_JQL_CHARS} characters.`);
    const jql = new QueryReader(tokensOf(input.jql)).query();
    const isCanonicalFormTooLong = jql.length > MAX_JQL_CHARS;
    if (isCanonicalFormTooLong) refuse(`a query holds at most ${MAX_JQL_CHARS} characters once written in its canonical form.`);
    return { ok: true, config: { jql, fields: fieldsOf(input.fields) } };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, issues: [error.message] };
    throw error;
  }
};
