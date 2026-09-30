import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveHome } from './config.js';
import { shortId } from './ids.js';
import { isSecretEntry, MASK, maskedSecrets, maskingCutCredential } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields { id?: string; sessionId?: string; code?: string; [key: string]: unknown }

const CONSOLE_METHOD_BY_LEVEL: Record<LogLevel, 'log' | 'warn' | 'error'> = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };

const RING_CAPACITY = 2000;
const MAX_LINE_CHARS = 8 * 1024;
// Above describeError's 4 KiB logged error plus its truncation suffix, and below the line cap so one whole string still fits a line.
const MAX_STRING_CHARS = 5 * 1024;
const MAX_KEY_CHARS = 128;
const MAX_CHILDREN = 50;
const MAX_DEPTH = 5;
const MAX_NODES = 256;
const MAX_ROOT_SPELLINGS = 4;
// A field with one of these names is ignored, by its own name and by its name once cleaned (`__pro​to__` cleans to `__proto__`).
const RESERVED_FIELD_KEYS = new Set(['ts', 'level', 'msg', 'id', 'sessionId', 'code', 'err', 'detail', 'cause', '__proto__']);

// Control, format (bidi, zero-width, BOM) and line/paragraph separator characters: a line splitter or a terminal honours them.
// The masking rules live in redact.ts, shared with describeError; strings are cut to MAX_STRING_CHARS before any of them runs.
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const UNRENDERABLE_EXCEPT_NEWLINE = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const PATH_CHARACTER = /[\w.-]/;

const ringBuffer: string[] = [];

export function recentLogLines(): string[] {
  return [...ringBuffer];
}

interface PathAlias { root: string; alias: string }

let pathAliases: PathAlias[] | undefined;

function spellingsOf(path: string): string[] {
  const spellings = [path];
  try { spellings.push(realpathSync(path)); } catch { /* the path may not exist: its configured spelling is enough */ }
  return [...new Set(spellings)].filter((spelling) => spelling.length > 1).map((spelling) => spelling.replace(/\/+$/, ''));
}

function computePathAliases(): PathAlias[] {
  const openfleetHomeAliases = spellingsOf(resolveHome()).map((root) => ({ root, alias: '$OPENFLEET_HOME' }));
  const userHomeAliases = spellingsOf(homedir()).map((root) => ({ root, alias: '~' }));
  return [...openfleetHomeAliases, ...userHomeAliases]
    .filter(({ root }) => root.length > 1)
    .sort((left, right) => right.root.length - left.root.length)
    .slice(0, MAX_ROOT_SPELLINGS);
}

const isPathCharacter = (character: string | undefined): boolean => character !== undefined && PATH_CHARACTER.test(character);

function shortenRoot(text: string, { root, alias }: PathAlias): string {
  let shortened = '';
  let copiedUpTo = 0;
  let searchFrom = 0;
  for (let at = text.indexOf(root); at !== -1; at = text.indexOf(root, searchFrom)) {
    const end = at + root.length;
    const isWholeSegment = !isPathCharacter(text[at - 1]) && !isPathCharacter(text[end]);
    searchFrom = isWholeSegment ? end : at + 1;
    if (!isWholeSegment) continue;
    shortened += text.slice(copiedUpTo, at) + alias;
    copiedUpTo = end;
  }
  return copiedUpTo === 0 ? text : shortened + text.slice(copiedUpTo);
}

function shortenPaths(text: string): string {
  pathAliases ??= computePathAliases();
  return pathAliases.reduce(shortenRoot, text);
}

function redactString(value: string, { keepNewlines = false } = {}): string {
  const isTooLong = value.length > MAX_STRING_CHARS;
  const capped = isTooLong ? `${maskingCutCredential(value.slice(0, MAX_STRING_CHARS))}…` : value;
  const printable = capped.replace(keepNewlines ? UNRENDERABLE_EXCEPT_NEWLINE : UNRENDERABLE, '');
  return shortenPaths(maskedSecrets(printable));
}

const attempt = <T>(read: () => T): T | undefined => {
  try { return read(); } catch { return undefined; }
};

function readOrPlaceholder(read: () => unknown): unknown {
  try { return read(); } catch { return '[unreadable]'; }
}

const isErrorLike =(value: unknown): value is Error => attempt(() => value instanceof Error || Object.prototype.toString.call(value) === '[object Error]') === true;

interface Walk { nodesLeft: number; ancestors: Set<object> }

function unboxed(value: object): unknown {
  const tag = attempt(() => Object.prototype.toString.call(value));
  if (tag === '[object String]') return attempt(() => String.prototype.valueOf.call(value));
  if (tag === '[object Number]') return attempt(() => Number.prototype.valueOf.call(value));
  if (tag === '[object Boolean]') return attempt(() => Boolean.prototype.valueOf.call(value));
  if (tag === '[object BigInt]') return attempt(() => BigInt.prototype.valueOf.call(value));
  return value;
}

function sanitizeEntries(entries: Iterable<[string, () => unknown]>, walk: Walk, depth: number): Record<string, unknown> {
  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [rawKey, read] of entries) {
    const key = redactString(rawKey.slice(0, MAX_KEY_CHARS));
    const rawValue = readOrPlaceholder(read);
    const value = isSecretEntry(key, rawValue) ? MASK : sanitize(rawValue, walk, depth + 1);
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

/** Bytes and collections are summarised by kind and size: their content can spell a secret and is never dumped. */
function summaryOfBytesOrCollection(value: object): string | undefined {
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`;
  if (ArrayBuffer.isView(value)) return `[${Object.prototype.toString.call(value).slice(8, -1)} ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  if (value instanceof Map) return `[Map ${value.size} entries]`;
  if (value instanceof Set) return `[Set ${value.size} entries]`;
  return undefined;
}

function sanitizeObject(value: object, walk: Walk, depth: number): unknown {
  if (walk.ancestors.has(value)) return '[circular]';
  const summary = summaryOfBytesOrCollection(value);
  if (summary !== undefined) return summary;
  walk.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_CHILDREN).map((item) => sanitize(item, walk, depth + 1));
      return value.length > MAX_CHILDREN ? [...items, `…${value.length - MAX_CHILDREN} more`] : items;
    }
    if (isErrorLike(value)) return serializeError(value, walk, depth);
    if (attempt(() => value instanceof Date)) return attempt(() => (value as Date).toISOString()) ?? '[invalid date]';
    const keys = Object.keys(value).slice(0, MAX_CHILDREN);
    return sanitizeEntries(keys.map((key): [string, () => unknown] => [key, () => (value as Record<string, unknown>)[key]]), walk, depth);
  } finally {
    walk.ancestors.delete(value);
  }
}

function sanitize(value: unknown, walk: Walk, depth: number): unknown {
  walk.nodesLeft -= 1;
  if (walk.nodesLeft < 0) return '[truncated]';
  if (value === undefined || value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return attempt(() => redactString(String(value))) ?? '[symbol]';
  if (typeof value === 'function') return '[function]';
  if (depth > MAX_DEPTH) return '[depth]';
  const contents = unboxed(value as object);
  if (contents !== value) return sanitize(contents, walk, depth);
  return attempt(() => sanitizeObject(value as object, walk, depth)) ?? '[unserializable]';
}

function serializeError(error: Error, walk: Walk, depth: number): Record<string, unknown> {
  const readText = (read: () => unknown, options?: { keepNewlines?: boolean }): string | undefined => {
    const text = attempt(read);
    return typeof text === 'string' ? redactString(text, options) : undefined;
  };
  const code = attempt(() => (error as { code?: unknown }).code);
  const cause = depth < MAX_DEPTH ? attempt(() => error.cause) : undefined;
  const serialized: Record<string, unknown> = {
    name: readText(() => error.name) ?? 'Error',
    message: readText(() => error.message) ?? '',
    stack: readText(() => error.stack, { keepNewlines: true }),
  };
  if (typeof code === 'string' || typeof code === 'number') serialized.code = sanitize(code, walk, depth + 1);
  if (cause !== undefined) serialized.cause = sanitize(cause, walk, depth + 1);
  return serialized;
}

function safeMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : (attempt(() => String(message)) ?? '[unprintable]');
  return redactString(text);
}

interface LogRecord { ts: string; level: LogLevel; msg: string; [key: string]: unknown }

function buildRecord(level: LogLevel, message: unknown, detail: unknown, fields: LogFields | undefined): LogRecord {
  const walk: Walk = { nodesLeft: MAX_NODES, ancestors: new Set() };
  const record: LogRecord = { ts: new Date().toISOString(), level, msg: safeMessage(message) };
  const callerId = attempt(() => fields?.id);
  const id = typeof callerId === 'string' && callerId !== '' ? redactString(callerId) : level === 'error' ? shortId() : undefined;
  if (id !== undefined) record.id = id;
  for (const key of ['sessionId', 'code'] as const) {
    const value = attempt(() => fields?.[key]);
    if (value !== undefined) record[key] = sanitize(value, walk, 1);
  }
  if (isErrorLike(detail)) record.err = sanitize(detail, walk, 1);
  else if (detail !== undefined) record.detail = sanitize(detail, walk, 1);
  const fieldKeys = attempt(() => Object.keys(fields ?? {})) ?? [];
  const extraKeys = fieldKeys.filter((key) => !RESERVED_FIELD_KEYS.has(key)).slice(0, MAX_CHILDREN);
  const extras = sanitizeEntries(extraKeys.map((key): [string, () => unknown] => [key, () => fields?.[key]]), walk, 0);
  for (const [key, value] of Object.entries(extras)) {
    const isReservedOnceCleaned = RESERVED_FIELD_KEYS.has(key);
    if (!isReservedOnceCleaned) record[key] = value;
  }
  return record;
}

/** A slice or a concatenation keeps its whole source string alive; a round trip through bytes returns a flat, independent string. */
const independentCopy = (text: string): string => Buffer.from(text, 'utf8').toString('utf8');

function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const head = independentCopy(line.slice(0, MAX_LINE_CHARS));
  return independentCopy(`${head}...[truncated ${line.length - MAX_LINE_CHARS} chars]`);
}

function toNdjson(record: LogRecord): string {
  const line = attempt(() => JSON.stringify(record)) ?? JSON.stringify({ ts: record.ts, level: record.level, msg: '[unserializable log record]' });
  return capLine(line);
}

const isPrintedInline = (value: unknown): boolean => typeof value === 'string' && value !== '' && !/[\s"=]/.test(value);
const printedValue = (value: unknown): string => (isPrintedInline(value) ? String(value) : (attempt(() => JSON.stringify(value)) ?? '[unprintable]'));

function toPretty(record: LogRecord): string {
  const clock = new Date(record.ts).toTimeString().slice(0, 8);
  const { ts: _ts, level: _level, msg: _msg, err, ...rest } = record;
  const pairs = Object.entries(rest).map(([key, value]) => `${key}=${printedValue(value)}`);
  const head = `${clock} ${record.level.toUpperCase()} ${record.msg}${pairs.length > 0 ? `  ${pairs.join(' ')}` : ''}`;
  const errorRecord = err as { name?: string; message?: string; stack?: string } | undefined;
  const stackText = errorRecord ? (errorRecord.stack ?? `${errorRecord.name}: ${errorRecord.message}`) : undefined;
  const stackLines = stackText === undefined ? '' : `\n${stackText.split('\n').map((line) => `    ${line}`).join('\n')}`;
  return capLine(head + stackLines);
}

// Only the exact lowercase value `debug` turns debug on; any other value (`DEBUG`, `warn`, …) leaves the default: info and above.
function isDebugEnabled(): boolean {
  return process.env.OPENFLEET_LOG_LEVEL === 'debug';
}

/** A stream whose isTTY cannot be read is treated as a plain file: the line is printed as NDJSON. */
const isTerminal = (stream: NodeJS.WriteStream): boolean => attempt(() => stream.isTTY === true) === true;

const KNOWN_LEVELS =new Set<string>(['debug', 'info', 'warn', 'error']);

// Best effort by contract: a logging failure of any kind must never reach the caller.
// Looks up console[method] at call time, not at import time, so tests can still spy on it.
export function log(level: LogLevel, message: string, detail?: unknown, fields?: LogFields): void {
  try {
    const knownLevel: LogLevel = KNOWN_LEVELS.has(level) ? level : 'info';
    if (knownLevel === 'debug' && !isDebugEnabled()) return;
    const record = buildRecord(knownLevel, message, detail, fields);
    const ndjson = toNdjson(record);
    ringBuffer.push(ndjson);
    if (ringBuffer.length > RING_CAPACITY) ringBuffer.shift();
    const consoleMethod = CONSOLE_METHOD_BY_LEVEL[knownLevel];
    const stream = consoleMethod === 'log' ? process.stdout : process.stderr;
    const printedLine = isTerminal(stream) ? toPretty(record) : ndjson;
    console[consoleMethod](printedLine);
  } catch {
    /* swallowed: see above */
  }
}
