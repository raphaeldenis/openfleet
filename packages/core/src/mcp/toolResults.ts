import { log } from '../logger.js';
import {
  ConstraintError, DaemonSetColumnError, DataStoreWriteError, DuplicateIdError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError, InvalidNameError,
  InvalidQueryError, InvalidViewConfigError, StoreHasRowsError, StoreRowCapError, ViewNotFoundError,
} from '../stores/dataStoreService.js';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError } from '../stores/dataStoreRepository.js';
import { FileBackedNoteError, NoteNotFoundError, NoteTooLargeError, StaleRevisionError, VersionNotFoundError } from '../notes/noteService.js';
import { SectionError } from '../notes/noteSections.js';

export const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
export const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** Keeps items until adding the next one would push the serialized result past maxBytes; always keeps at least one. */
export function truncateToByteBudget<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
  let bytes = 0;
  const kept: T[] = [];
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (kept.length > 0 && bytes + itemBytes > maxBytes) return { items: kept, truncated: true };
    bytes += itemBytes;
    kept.push(item);
  }
  return { items: kept, truncated: false };
}

// Typed errors whose message was written for the caller and carries no SQL or internal state.
const CALLER_SAFE_ERRORS = [
  ConstraintError, DaemonSetColumnError, DataStoreWriteError, DuplicateIdError, DuplicateNameError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError,
  InvalidNameError, InvalidQueryError, InvalidViewConfigError, StoreHasRowsError, StoreRowCapError, UnknownColumnError,
  NoteTooLargeError, SectionError, VersionNotFoundError,
];

/**
 * Runs a table-tool body, mapping typed service/repository errors to a non-throwing `fail()`. A store, view or row
 * outside the caller's project reads identically to one that never existed. Any other error is logged and reads as
 * an opaque 'request failed' so no SQL or internal text reaches the caller.
 */
export function guarded<T>(work: () => T) {
  try {
    return ok(work());
  } catch (error) {
    if (error instanceof StoreNotFoundError) return fail('data store not found');
    if (error instanceof ViewNotFoundError) return fail('view not found');
    if (error instanceof RowNotFoundError) return fail('row not found');
    if (error instanceof NoteNotFoundError) return fail('note not found');
    if (error instanceof StaleRevisionError) return fail(`409 stale_revision, current rev: ${error.currentRev}`);
    if (error instanceof FileBackedNoteError) return fail('note is file-backed; this operation is not supported for file-backed notes');
    if (CALLER_SAFE_ERRORS.some((safeError) => error instanceof safeError)) return fail((error as Error).message);
    log('error', 'mcp tool failed', error);
    return fail('request failed');
  }
}
