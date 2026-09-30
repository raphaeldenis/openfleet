import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { ERROR_CODES, OpenFleetError, retryOf, type ErrorCode, type ErrorEnvelope } from '@openfleet/shared';
import { InvalidJsonBodyError, PayloadTooLargeError } from '../api/router.js';
import { resolveHome } from '../config.js';
import { StuckConnectionError } from '../db/transaction.js';
import { ApprovalError } from '../governance/approvalService.js';
import { shortId } from '../ids.js';
import { log } from '../logger.js';
import { ModelConfigReadOnlyError, ModelConfigUnreadableError } from '../models.js';
import { WorktreeError } from '../git/worktrees.js';
import {
  NoteFileUnreadableError, NoteIsNotFileBackedError, PathEscapesDocsFolderError, ProjectHasNoDocsFolderError, ProjectNotFoundError,
} from '../notes/docsFolderService.js';
import { SessionHasNoProjectError, SessionNotFoundForHandoffError } from '../notes/handoffService.js';
import { SectionError } from '../notes/noteSections.js';
import { WorkingStateTooLargeError } from '../workingState/workingStateService.js';
import { FileBackedNoteError, NoteNotFoundError, NoteTooLargeError, StaleRevisionError, VersionNotFoundError } from '../notes/noteService.js';
import {
  DaemonShuttingDownError, MessageIdAlreadyUsedError, SessionClosedError, SessionReopenError, TooManyPendingMessagesError, UnknownHarnessError,
} from '../sessions/sessionService.js';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError } from '../stores/dataStoreRepository.js';
import {
  ConstraintError, DaemonSetColumnError, DuplicateIdError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError, InvalidNameError, InvalidQueryError,
  InvalidViewConfigError, StoreHasRowsError, StoreRowCapError, ViewNotFoundError,
} from '../stores/dataStoreService.js';

const MAX_MESSAGE_CHARS = 300;
const MAX_HINT_CHARS = 200;
const MAX_DETAIL_BYTES = 2048;
const ELLIPSIS = '…';

export interface ErrorScope {
  sessionId?: string;
  /** Names the failing site in the log line, e.g. `GET /api/sessions → 500`. */
  where?: string;
}

interface Entry { code: ErrorCode; message: string; hint?: string; detail?: unknown }
type Rule = (error: unknown) => Entry | undefined;

const when = <E extends Error>(ErrorClass: new (...args: never[]) => E, describe: (error: E) => Entry | undefined): Rule =>
  (error) => (error instanceof ErrorClass ? describe(error) : undefined);

const asIs = (code: ErrorCode) => (error: Error): Entry => ({ code, message: error.message });
const asDetail = (code: ErrorCode, message: string) => (error: Error): Entry => ({ code, message, detail: error.message });

// A ZodError is matched by name, not by class: one thrown by a second copy of zod is a different class.
const isNamedZodError = (error: unknown): error is { message: string } =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ZodError';
const isForeignKeyError = (error: unknown): error is Error =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY/i.test(error.message);

// Messages that would carry a path (or a directory name) are fixed here, never forwarded.
const REOPEN_ENTRY_BY_CODE: Record<SessionReopenError['code'], Omit<Entry, 'code'>> = {
  not_closed: { message: 'the session is not closed.' },
  directory_missing: { message: 'the session directory no longer exists.', hint: 'restore the directory, then reopen the session.' },
  directory_changed: { message: 'the session directory changed since the session closed.', hint: 'restore the original directory, then reopen the session.' },
  directory_unreadable: { message: 'the session directory cannot be read.', hint: 'fix its permissions, then reopen the session.' },
  launch_failed: { message: 'the session failed to launch.' },
};

// Wire change: POST /api/sessions with repoPath + branchName answered 500 internal_error for these two before ERR-01; it now answers 400 / 409.
// A failed git command stays internal: its message is git's own output.
const WORKTREE_ENTRY_BY_CODE: Record<WorktreeError['code'], (error: WorktreeError) => Entry | undefined> = {
  invalid_branch: asIs('invalid_branch_name'),
  exists: () => ({ code: 'worktree_exists', message: 'the worktree already exists.' }),
  git_failed: () => undefined,
};

const UNEXPECTED_ENTRY: Entry = { code: 'internal_error', message: 'the daemon hit an unexpected error.' };

// An internal error never forwards its own words: the log carries them, the caller gets the generic sentence and the id.
const describedOpenFleetError = (error: OpenFleetError): Entry =>
  error.kind === 'internal'
    ? { code: error.code, message: UNEXPECTED_ENTRY.message }
    : { code: error.code, message: error.message, hint: error.options.hint, detail: error.options.detail };

const RULES: Rule[] = [
  when(OpenFleetError, describedOpenFleetError),
  when(PayloadTooLargeError, asIs('payload_too_large')),
  when(InvalidJsonBodyError, asDetail('invalid_json', 'the request body is not valid JSON.')),
  (error) => (isNamedZodError(error) ? { code: 'invalid_body', message: 'the request body is invalid.', detail: error.message } : undefined),
  (error) => (isForeignKeyError(error) ? { code: 'project_not_found', message: 'the project does not exist.' } : undefined),
  when(StuckConnectionError, () => ({ code: 'db_stuck', message: 'the database is not accepting work.', hint: 'restart the daemon.' })),

  when(SessionClosedError, asIs('session_closed')),
  when(DaemonShuttingDownError, asIs('daemon_shutting_down')),
  when(UnknownHarnessError, (error) => ({ code: 'unknown_harness', message: error.message, detail: error.message })),
  when(MessageIdAlreadyUsedError, asIs('message_id_reused')),
  when(TooManyPendingMessagesError, asIs('too_many_pending')),
  when(SessionReopenError, (error) => ({ code: error.code, ...REOPEN_ENTRY_BY_CODE[error.code] })),
  when(ApprovalError, (error) => ({ code: error.code, message: error.message })),
  when(ModelConfigUnreadableError, asDetail('config_unreadable', 'the model config cannot be read.')),
  when(ModelConfigReadOnlyError, asDetail('config_read_only', 'the model config is read-only.')),

  when(NoteNotFoundError, asIs('not_found')),
  when(VersionNotFoundError, asIs('not_found')),
  when(StaleRevisionError, (error) => ({ code: 'stale_revision', message: error.message, hint: 'reload the note, then save again.', detail: { currentRev: error.currentRev } })),
  when(FileBackedNoteError, asIs('file_backed')),
  when(NoteFileUnreadableError, () => ({ code: 'file_unreadable', message: 'the note file cannot be read.', hint: 'restore the docs folder or the file permissions, then retry.' })),
  when(PathEscapesDocsFolderError, () => ({ code: 'path_escapes_docs_folder', message: 'the path escapes the docs folder.' })),
  when(NoteTooLargeError, asIs('note_too_large')),
  when(ProjectNotFoundError, asIs('project_not_found')),

  when(StoreNotFoundError, asIs('not_found')),
  when(RowNotFoundError, asIs('not_found')),
  when(ViewNotFoundError, asIs('view_not_found')),
  when(DuplicateNameError, asIs('duplicate_name')),
  when(ConstraintError, asDetail('constraint_violation', 'the change breaks a constraint.')),
  when(StoreRowCapError, asIs('row_cap')),
  when(DaemonSetColumnError, asDetail('invalid_body', 'the column is set by the daemon.')),
  when(InvalidCellValueError, asDetail('invalid_body', 'a cell value is invalid.')),
  when(InvalidNameError, asDetail('invalid_body', 'the name is invalid.')),
  when(InvalidQueryError, asDetail('invalid_body', 'the query is invalid.')),
  when(UnknownColumnError, asDetail('invalid_body', 'a column is unknown.')),
  when(StoreHasRowsError, asIs('store_has_rows')),
  when(DuplicateIdError, asIs('duplicate_id')),
  when(InvalidViewConfigError, asIs('invalid_body')),
  when(InvalidColumnDefinitionError, asIs('invalid_body')),
  when(InvalidActorError, asIs('invalid_body')),
  when(SectionError, asIs('invalid_body')),

  when(WorkingStateTooLargeError, asIs('state_too_large')),
  when(SessionNotFoundForHandoffError, asIs('session_not_found')),
  when(SessionHasNoProjectError, asIs('project_not_found')),
  when(ProjectHasNoDocsFolderError, asIs('no_docs_folder')),
  when(NoteIsNotFileBackedError, asIs('not_file_backed')),
  when(WorktreeError, (error) => WORKTREE_ENTRY_BY_CODE[error.code](error)),
];

function entryFor(error: unknown): Entry | undefined {
  try {
    return RULES.map((rule) => rule(error)).find((entry) => entry !== undefined);
  } catch {
    return undefined;
  }
}

const SECRET_KEY = /token|secret|authorization|password/i;
const MASK = '***';
const escapedForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A percent-escape however many times it is encoded (%2F, %252F, …). */
const ESCAPE_PREFIX = '%(?:25)*';
const hexOf = (character: string) => character.charCodeAt(0).toString(16).padStart(2, '0');

/** Matches `word` with any of its characters written as a percent-escape. */
const spelledWithEscapes = (word: string): string =>
  Array.from(word)
    .map((character) => `(?:${escapedForRegExp(character)}|${ESCAPE_PREFIX}(?:${hexOf(character.toLowerCase())}|${hexOf(character.toUpperCase())}))`)
    .join('');

const SLASH = `(?:/|${ESCAPE_PREFIX}2F)`;
const BEARER_SEPARATOR = `(?:[\\s:=]|${ESCAPE_PREFIX}(?:20|3A|3D|09))+`;
// A token segment keeps every escape, valid or not: masking the whole segment is what hides a token spelled with escapes.
const BEARER_TOKEN = new RegExp(`${spelledWithEscapes('Bearer')}${BEARER_SEPARATOR}[A-Za-z0-9._~+/=%-]+`, 'gi');
const HOOK_TOKEN = new RegExp(`${SLASH}${spelledWithEscapes('hooks')}${SLASH}[^/\\s"'\`&]+`, 'gi');
const QUERY_PARAMETER = /([?&])([^=&\s"'`#]*)=([^&\s"'`]*)/g;

/** Decodes every well-formed percent-escape, up to three layers deep; a malformed one stays as it is and nothing throws. */
function withEscapesDecoded(text: string): string {
  let decoded = text;
  for (let layer = 0; layer < 3; layer += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

const maskingSecretParameters = (parameter: string, prefix: string, key: string): string =>
  SECRET_KEY.test(withEscapesDecoded(key)) ? `${prefix}${key}=${MASK}` : parameter;

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Absolute homes only: a relative OPENFLEET_HOME would match ordinary words. Each home is listed as configured and as its realpath.
 * Longest first, so a home inside another shortens as the inner one.
 */
const homePrefixes = (): string[] => {
  const configuredHomes = [resolveHome(), homedir()].filter((home) => isAbsolute(home));
  const spellings = configuredHomes.flatMap((home) => [home, realpathOrSelf(home)]);
  const withoutTrailingSeparators = spellings.map((home) => home.replace(/[/\\]+$/, '')).filter((home) => home.length > 1);
  return [...new Set(withoutTrailingSeparators)].sort((first, second) => second.length - first.length);
};

const startsPathSegment = (home: string) => new RegExp(`(?<![\\w.~-])${escapedForRegExp(home)}(?![\\w-])(?!\\.\\w)`, 'g');

function redactedAndShortened(text: string): string {
  const withoutSecrets = text
    .replace(BEARER_TOKEN, `Bearer ${MASK}`)
    .replace(QUERY_PARAMETER, (parameter, prefix: string, key: string) => maskingSecretParameters(parameter, prefix, key))
    .replace(HOOK_TOKEN, `/hooks/${MASK}`);
  return homePrefixes().reduce((shortened, home) => shortened.replace(startsPathSegment(home), '~'), withoutSecrets);
}

// Control, format (bidi, zero-width, BOM) and line/paragraph separator characters: the desktop renders what is left.
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const oneLine = (text: string) => text.replace(/[\n\r\t]+/g, ' ').replace(UNRENDERABLE, '');
const keepingLines = (text: string) => text.replace(UNRENDERABLE, (character) => (character === '\n' || character === '\t' ? character : ''));

/** Cuts at `maxChars` code points, so a surrogate pair is never split; the ellipsis counts as the last one. */
function truncated(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) return text;
  return codePoints.slice(0, maxChars - 1).join('') + ELLIPSIS;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

function cappedText(text: string, maxChars: number): string {
  return truncated(redactedAndShortened(oneLine(text)), maxChars);
}

function cappedDetailText(text: string): string {
  const clean = redactedAndShortened(keepingLines(text));
  let chars = MAX_DETAIL_BYTES;
  let candidate = truncated(clean, chars);
  while (jsonBytes(candidate) > MAX_DETAIL_BYTES && chars > 1) {
    chars = Math.floor(chars * 0.9);
    candidate = truncated(clean, chars);
  }
  return candidate;
}

const cleanedText = (text: string) => redactedAndShortened(keepingLines(text));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON.stringify unboxes a String, Number or Boolean object after the replacer ran, so the replacer unboxes it first. */
function unboxed(value: unknown): unknown {
  if (value instanceof String) return String.prototype.valueOf.call(value);
  if (value instanceof Number) return Number.prototype.valueOf.call(value);
  if (value instanceof Boolean) return Boolean.prototype.valueOf.call(value);
  return value;
}

const withCleanedKeys = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).map(([key, entry]) => [cleanedText(key), entry]));

const sanitizingKeysAndValues = (key: string, rawValue: unknown): unknown => {
  if (SECRET_KEY.test(key)) return MASK;
  const value = unboxed(rawValue);
  if (typeof value === 'string') return cleanedText(value);
  return isPlainObject(value) ? withCleanedKeys(value) : value;
};

function parsedOrText(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return cappedDetailText(serialized);
  }
}

/**
 * A string is cleaned and cut at 2 KiB serialized. A structure is serialized once, with every key and string value cleaned and every secret key masked,
 * then the serialized text is redacted a last time whatever its size: one that fits is answered as that parsed copy (as text when the redaction broke the JSON),
 * one that does not is cut to text; one that cannot be serialized is dropped.
 */
function cappedDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  if (typeof detail === 'string') return cappedDetailText(detail);
  try {
    const serialized = JSON.stringify(detail, sanitizingKeysAndValues);
    if (serialized === undefined) return undefined;
    const redacted = redactedAndShortened(serialized);
    return Buffer.byteLength(redacted) <= MAX_DETAIL_BYTES ? parsedOrText(redacted) : cappedDetailText(redacted);
  } catch {
    return undefined;
  }
}

function logInternalError(error: unknown, { id, scope }: { id: string; scope: ErrorScope }): void {
  const site = scope.where ?? 'unexpected error';
  const sessionSuffix = scope.sessionId ? ` session=${scope.sessionId}` : '';
  const line = `${site} [${id}]${sessionSuffix}`;
  try {
    log('error', line, error);
  } catch {
    tryLogging(`${line} (error cannot be printed)`);
  }
}

function tryLogging(line: string): void {
  try {
    log('error', line);
  } catch {
    // logging is best effort: an unwritable log never stops the answer
  }
}

/**
 * Turns any thrown value into the envelope every transport sends. It never throws: an entry it cannot describe
 * falls back to the unexpected-error entry. A typed error is expected and is not logged;
 * an error of kind `internal` gets an id and is the one thing this function logs, at `error` level, with that id.
 */
export function describeError(error: unknown, scope: ErrorScope = {}): ErrorEnvelope {
  try {
    return envelopeFor(entryFor(error) ?? UNEXPECTED_ENTRY, error, scope);
  } catch {
    return envelopeFor(UNEXPECTED_ENTRY, error, scope);
  }
}

function envelopeFor(entry: Entry, error: unknown, scope: ErrorScope): ErrorEnvelope {
  const { kind } = ERROR_CODES[entry.code];
  const isInternal = kind === 'internal';
  const id = isInternal ? shortId() : undefined;
  if (id) logInternalError(error, { id, scope });
  const referenceSentence = id ? `Report ref ${id} if it happens again.` : undefined;
  const hint = [entry.hint, referenceSentence].filter(Boolean).join(' ') || undefined;
  return {
    error: entry.code,
    kind,
    retry: retryOf(entry.code),
    message: cappedText(entry.message, MAX_MESSAGE_CHARS),
    ...(hint && { hint: cappedText(hint, MAX_HINT_CHARS) }),
    ...(entry.detail !== undefined && { detail: cappedDetail(entry.detail) }),
    ...(id && { id }),
  };
}
