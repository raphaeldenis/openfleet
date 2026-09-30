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
import { escapedForRegExp, MASK, maskedSecrets, maskingCutCredential, SECRET_KEY } from '../redact.js';
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

/** The home patterns are built once per described error, not once per string. */
const homePatterns = (): RegExp[] => homePrefixes().map(startsPathSegment);

function redactedAndShortened(text: string, homes: RegExp[]): string {
  return homes.reduce((shortened, home) => shortened.replace(home, '~'), maskedSecrets(text));
}

// Redaction only ever sees the head of a text: what a cap cuts off is never scanned. The raw head is wider than the cap so that
// removed characters (control characters, a masked token) do not leave the capped text short.
const RAW_HEAD_FACTOR = 4;
function headBeforeRedaction(text: string, maxChars: number): string {
  const rawLimit = maxChars * RAW_HEAD_FACTOR;
  return text.length > rawLimit ? maskingCutCredential(text.slice(0, rawLimit)) + ELLIPSIS : text;
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

function cappedText(text: string, maxChars: number, homes: RegExp[]): string {
  return truncated(redactedAndShortened(oneLine(headBeforeRedaction(text, maxChars)), homes), maxChars);
}

function cappedDetailText(text: string, homes: RegExp[]): string {
  const clean = redactedAndShortened(keepingLines(headBeforeRedaction(text, MAX_DETAIL_BYTES)), homes);
  let chars = MAX_DETAIL_BYTES;
  let candidate = truncated(clean, chars);
  while (jsonBytes(candidate) > MAX_DETAIL_BYTES && chars > 1) {
    chars = Math.floor(chars * 0.9);
    candidate = truncated(clean, chars);
  }
  return candidate;
}

const cleanedText = (text: string, homes: RegExp[]) => redactedAndShortened(keepingLines(headBeforeRedaction(text, MAX_DETAIL_BYTES)), homes);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON.stringify unboxes a String, Number or Boolean object after the replacer ran, so the replacer unboxes it first. */
function unboxed(value: unknown): unknown {
  if (value instanceof String) return String.prototype.valueOf.call(value);
  if (value instanceof Number) return Number.prototype.valueOf.call(value);
  if (value instanceof Boolean) return Boolean.prototype.valueOf.call(value);
  return value;
}

/**
 * A key that needs no cleaning keeps its name. A cleaned key that would land on a name already taken gets a ` (2)`, ` (3)`, … suffix,
 * so cleaning never drops an entry.
 */
function withCleanedKeys(value: Record<string, unknown>, homes: RegExp[]): Record<string, unknown> {
  const entries = Object.entries(value).map(([key, entry]) => ({ key, entry, cleanedKey: cleanedText(key, homes) }));
  const takenKeys = new Set(entries.filter(({ key, cleanedKey }) => key === cleanedKey).map(({ key }) => key));
  const nextSuffixByCleanedKey = new Map<string, number>();
  const distinctKeyFor = (cleanedKey: string): string => {
    let suffix = nextSuffixByCleanedKey.get(cleanedKey) ?? 1;
    let candidate = suffix === 1 ? cleanedKey : `${cleanedKey} (${suffix})`;
    while (takenKeys.has(candidate)) {
      suffix += 1;
      candidate = `${cleanedKey} (${suffix})`;
    }
    nextSuffixByCleanedKey.set(cleanedKey, suffix + 1);
    takenKeys.add(candidate);
    return candidate;
  };
  return Object.fromEntries(entries.map(({ key, entry, cleanedKey }) => [key === cleanedKey ? key : distinctKeyFor(cleanedKey), entry]));
}

const sanitizerOfKeysAndValues = (homes: RegExp[]) => (key: string, rawValue: unknown): unknown => {
  if (SECRET_KEY.test(key)) return MASK;
  const value = unboxed(rawValue);
  if (typeof value === 'string') return cleanedText(value, homes);
  return isPlainObject(value) ? withCleanedKeys(value, homes) : value;
};

function parsedOrText(serialized: string, homes: RegExp[]): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return cappedDetailText(serialized, homes);
  }
}

/**
 * A string is cleaned and cut at 2 KiB serialized. A structure is serialized once, with every key and string value cleaned and every secret key masked,
 * then the serialized text is redacted a last time: one that fits is answered as that parsed copy (as text when the redaction broke the JSON),
 * one that does not is cut to text, and only its head is scanned; one that cannot be serialized is dropped.
 */
function cappedDetail(detail: unknown, homes: RegExp[]): unknown {
  if (detail === undefined) return undefined;
  if (typeof detail === 'string') return cappedDetailText(detail, homes);
  try {
    const serialized = JSON.stringify(detail, sanitizerOfKeysAndValues(homes));
    if (serialized === undefined) return undefined;
    const exceedsCapWhateverTheRedaction = serialized.length > MAX_DETAIL_BYTES * RAW_HEAD_FACTOR;
    if (exceedsCapWhateverTheRedaction) return cappedDetailText(serialized, homes);
    const redacted = redactedAndShortened(serialized, homes);
    return Buffer.byteLength(redacted) <= MAX_DETAIL_BYTES ? parsedOrText(redacted, homes) : cappedDetailText(redacted, homes);
  } catch {
    return undefined;
  }
}

const MAX_LOGGED_ERROR_CHARS = 4096;

/** The error itself when its text fits the log cap; otherwise the masked head of that text and the count of characters left out. */
function loggableError(error: unknown): unknown {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  if (text.length <= MAX_LOGGED_ERROR_CHARS) return error;
  const omittedChars = text.length - MAX_LOGGED_ERROR_CHARS;
  return `${maskedSecrets(maskingCutCredential(text.slice(0, MAX_LOGGED_ERROR_CHARS)))}${ELLIPSIS}[truncated ${omittedChars} chars]`;
}

function logInternalError(error: unknown, { id, code, scope }: { id: string; code: string; scope: ErrorScope }): void {
  const site = scope.where ?? 'unexpected error';
  const sessionSuffix = scope.sessionId ? ` session=${scope.sessionId}` : '';
  const line = `${site} [${id}]${sessionSuffix}`;
  const fields = { id, code, ...(scope.sessionId && { sessionId: scope.sessionId }) };
  try {
    log('error', line, loggableError(error), fields);
  } catch {
    tryLogging(`${line} (error cannot be printed)`, fields);
  }
}

function tryLogging(line: string, fields: { id: string; code: string; sessionId?: string }): void {
  try {
    log('error', line, undefined, fields);
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
  if (id) logInternalError(error, { id, code: entry.code, scope });
  const referenceSentence = id ? `Report ref ${id} if it happens again.` : undefined;
  const hint = [entry.hint, referenceSentence].filter(Boolean).join(' ') || undefined;
  const homes = homePatterns();
  return {
    error: entry.code,
    kind,
    retry: retryOf(entry.code),
    message: cappedText(entry.message, MAX_MESSAGE_CHARS, homes),
    ...(hint && { hint: cappedText(hint, MAX_HINT_CHARS, homes) }),
    ...(entry.detail !== undefined && { detail: cappedDetail(entry.detail, homes) }),
    ...(id && { id }),
  };
}
