import { OpenFleetError, type ErrorCode, type ErrorEnvelope, type Session } from '@openfleet/shared';
import { describeError, type ErrorScope } from '../errors/describeError.js';
import {
  ConstraintError, DaemonSetColumnError, DataStoreWriteError, DuplicateIdError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError, InvalidNameError,
  InvalidQueryError, InvalidViewConfigError, StoreHasRowsError, StoreRowCapError, ViewNotFoundError,
} from '../stores/dataStoreService.js';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError } from '../stores/dataStoreRepository.js';
import { FileBackedNoteError, NoteNotFoundError, NoteTooLargeError, StaleRevisionError, VersionNotFoundError } from '../notes/noteService.js';
import { NoteFileUnreadableError } from '../notes/docsFolderService.js';
import { SectionError } from '../notes/noteSections.js';

export const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

// The tag is the last group of the line, so a "(retry:" inside a message or a hint is escaped: the text never carries a second one.
const withoutRetryTag = (text: string) => text.replaceAll('(retry:', '(retry\\:');

const MAX_SENTENCES_CHARS = 500;
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const oneLine = (text: string) => text.replace(/[\n\r\t]+/g, ' ').replace(UNRENDERABLE, '').trim();
const cappedAt = (text: string, maxChars: number) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);
const wordingOfEmptyMessage = (envelope: ErrorEnvelope) => `${envelope.error.replaceAll('_', ' ')}.`;

/** `error <code>: <message> <hint> (retry: <never|after_refresh|later>[, ref <id>])`: one line, code first, tag last, whatever the envelope holds. */
export function errorText(envelope: ErrorEnvelope): string {
  const cleanMessage = oneLine(envelope.message);
  const message = cleanMessage || wordingOfEmptyMessage(envelope);
  const sentences = [message, envelope.hint && oneLine(envelope.hint)].filter((sentence): sentence is string => Boolean(sentence)).join(' ');
  const reference = envelope.id ? `, ref ${envelope.id}` : '';
  return `error ${envelope.error}: ${withoutRetryTag(cappedAt(sentences, MAX_SENTENCES_CHARS))} (retry: ${envelope.retry}${reference})`;
}

export const fail = (envelope: ErrorEnvelope) => ({ content: [{ type: 'text' as const, text: errorText(envelope) }], isError: true });

/** A refusal the tool itself decides: the registry code fixes the retry tag, the message is caller-safe text. */
export const refuse = (code: ErrorCode, message: string, hint?: string) => fail(describeError(new OpenFleetError(code, message, { hint })));

/** Keeps items until adding the next one would push the serialized result past maxBytes; always keeps at least one. `bytesBetweenItems` counts the separator serialized between two items. */
export function truncateToByteBudget<T>(items: T[], maxBytes: number, { bytesBetweenItems = 0 }: { bytesBetweenItems?: number } = {}): { items: T[]; truncated: boolean } {
  let bytes = 0;
  const kept: T[] = [];
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + (kept.length > 0 ? bytesBetweenItems : 0);
    if (kept.length > 0 && bytes + itemBytes > maxBytes) return { items: kept, truncated: true };
    bytes += itemBytes;
    kept.push(item);
  }
  return { items: kept, truncated: false };
}

interface ToolWording { code?: ErrorCode; message: string; hint?: string }

// A store, view, row or note outside the caller's project reads identically to one that never existed: the id stays out of the words.
const FIXED_WORDING: [new (...args: never[]) => Error, ToolWording][] = [
  [StoreNotFoundError, { code: 'store_not_found', message: 'data store not found' }],
  [ViewNotFoundError, { code: 'view_not_found', message: 'view not found' }],
  [RowNotFoundError, { code: 'row_not_found', message: 'row not found' }],
  [NoteNotFoundError, { code: 'note_not_found', message: 'note not found' }],
  [FileBackedNoteError, { message: 'note is file-backed; this operation is not supported for file-backed notes' }],
  // The error's own message names the file path, which stays out of the caller's reach.
  [NoteFileUnreadableError, { message: 'note is file-backed and its file or docs folder cannot be read; nothing was written.', hint: 'Restore the docs folder or the file permissions, then retry.' }],
];

// Typed errors whose message was written for the caller and carries no SQL or internal state.
const CALLER_SAFE_ERRORS = [
  ConstraintError, DaemonSetColumnError, DuplicateIdError, DuplicateNameError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError,
  InvalidNameError, InvalidQueryError, InvalidViewConfigError, StoreHasRowsError, StoreRowCapError, UnknownColumnError,
  NoteTooLargeError, SectionError, VersionNotFoundError,
];

const STALE_REVISION_HINT = 'Reload the note, then write again.';
const WRITE_FAILED_MESSAGE = 'The write failed.';

function toolWordingOf(error: unknown): ToolWording | undefined {
  const fixed = FIXED_WORDING.find(([ErrorClass]) => error instanceof ErrorClass);
  if (fixed) return fixed[1];
  if (error instanceof StaleRevisionError) return { message: `the note revision is stale, current rev: ${error.currentRev}.`, hint: STALE_REVISION_HINT };
  if (CALLER_SAFE_ERRORS.some((safeError) => error instanceof safeError)) return { message: (error as Error).message };
  return undefined;
}

/** What the store refused about a request, in the words an agent reads; undefined when the error is no refusal of the request (a failed write, a bug). */
export const refusalReasonOf = (error: unknown): string | undefined => toolWordingOf(error)?.message;

/**
 * The envelope an agent reads: the shared mapping, with the words the tools have always used for the typed errors above.
 * A failed data-store write keeps its safe message on the internal envelope: the id and the log line come from the mapping.
 */
export function describeToolError(error: unknown, scope: ErrorScope = {}): ErrorEnvelope {
  const described = describeError(error, scope);
  try {
    if (error instanceof DataStoreWriteError) return { ...described, message: WRITE_FAILED_MESSAGE };
    const wording = toolWordingOf(error);
    if (!wording) return described;
    const { code = described.error, message, hint = described.hint } = wording;
    return describeError(new OpenFleetError(code, message, { hint }), scope);
  } catch {
    return described;
  }
}

const scopeOf = (caller: Session): ErrorScope => ({ sessionId: caller.id, where: 'mcp tool failed' });

/** Runs a tool body, mapping any thrown value to a non-throwing `fail()`: no SQL or internal text reaches the caller, an unexpected error is logged with the ref the caller reads. */
export function guarded<T>(work: () => T, scope: ErrorScope = { where: 'mcp tool failed' }) {
  try {
    return ok(work());
  } catch (error) {
    return fail(describeToolError(error, scope));
  }
}

/** `guarded` for one caller, so the log line of an unexpected error names the session. */
export const guardedFor = (caller: Session) => <T>(work: () => T) => guarded(work, scopeOf(caller));

/** Wraps a tool handler so that a throw, sync or async, answers in the grammar instead of reaching the SDK's own error text. */
export const catchingToolErrors = (caller: Session) => <Args extends unknown[], Result>(handler: (...args: Args) => Result | Promise<Result>) =>
  async (...args: Args): Promise<Result | ReturnType<typeof fail>> => {
    try {
      return await handler(...args);
    } catch (error) {
      return fail(describeToolError(error, scopeOf(caller)));
    }
  };
