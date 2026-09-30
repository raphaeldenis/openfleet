import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveHome } from './config.js';
import { shortId } from './ids.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields { id?: string; sessionId?: string; code?: string; [key: string]: unknown }

const CONSOLE_METHOD_BY_LEVEL: Record<LogLevel, 'log' | 'warn' | 'error'> = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };

const RING_CAPACITY = 2000;
const MAX_LINE_CHARS = 16 * 1024;
const MAX_STRING_CHARS = 4 * 1024;
const MAX_KEY_CHARS = 128;
const MAX_CHILDREN = 50;
const MAX_DEPTH = 5;
const MAX_NODES = 256;
const MAX_ROOT_SPELLINGS = 4;
const MASKED = '***';
const RESERVED_FIELD_KEYS = new Set(['ts', 'level', 'msg', 'id', 'sessionId', 'code', 'err']);

// Every pattern below is linear: each character is consumed by exactly one alternative, and strings are
// cut to MAX_STRING_CHARS before any of them runs.
const CONTROL_AND_BIDI_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const BEARER_TOKEN = /bearer(?:%20|[\s:])+[^\s"',;]*/gi;
const HOOK_TOKEN = /(?:\/|%2f|%252f)hooks(?:\/|%2f|%252f)(?:[^/\s%]|%(?!2f|252f))*/gi;
const SENSITIVE_KEY = /token|secret|authorization|password/i;
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
  const capped = value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  const printable = capped.replace(keepNewlines ? CONTROL_AND_BIDI_EXCEPT_NEWLINE : CONTROL_AND_BIDI, '');
  const withoutBearer = printable.replace(BEARER_TOKEN, `Bearer ${MASKED}`);
  const withoutHookToken = withoutBearer.replace(HOOK_TOKEN, `/hooks/${MASKED}`);
  return shortenPaths(withoutHookToken);
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
    const isSensitive = SENSITIVE_KEY.test(key);
    const value = isSensitive ? MASKED : sanitize(readOrPlaceholder(read), walk, depth + 1);
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

function sanitizeObject(value: object, walk: Walk, depth: number): unknown {
  if (walk.ancestors.has(value)) return '[circular]';
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
  return Object.assign(record, extras, { ts: record.ts, level: record.level, msg: record.msg });
}

function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}...[truncated ${line.length - MAX_LINE_CHARS} chars]`;
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

function isDebugEnabled(): boolean {
  return process.env.OPENFLEET_LOG_LEVEL === 'debug';
}

const KNOWN_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

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
    const printedLine = process.stdout.isTTY === true ? toPretty(record) : ndjson;
    console[CONSOLE_METHOD_BY_LEVEL[knownLevel]](printedLine);
  } catch {
    /* swallowed: see above */
  }
}
