import { homedir } from 'node:os';
import { ZodError, z } from 'zod';
import { OpenFleetError, type ErrorCode } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidJsonBodyError, PayloadTooLargeError } from '../api/router.js';
import { StuckConnectionError } from '../db/transaction.js';
import { ApprovalError } from '../governance/approvalService.js';
import { ModelConfigReadOnlyError, ModelConfigUnreadableError } from '../models.js';
import { NoteFileUnreadableError, PathEscapesDocsFolderError, ProjectNotFoundError } from '../notes/docsFolderService.js';
import { FileBackedNoteError, NoteNotFoundError, NoteTooLargeError, StaleRevisionError, VersionNotFoundError } from '../notes/noteService.js';
import {
  DaemonShuttingDownError, MessageIdAlreadyUsedError, SessionClosedError, SessionReopenError, TooManyPendingMessagesError, UnknownHarnessError,
} from '../sessions/sessionService.js';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError } from '../stores/dataStoreRepository.js';
import {
  ConstraintError, DaemonSetColumnError, InvalidCellValueError, InvalidNameError, InvalidQueryError, StoreRowCapError, ViewNotFoundError,
} from '../stores/dataStoreService.js';
import { describeError } from './describeError.js';

const ID_PATTERN = /^[0-9a-f]{8}$/;

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

const foreignKeyError = () => Object.assign(new Error('FOREIGN KEY constraint failed'), { code: 'ERR_SQLITE_ERROR' });

const domainErrorCodes: [string, () => unknown, ErrorCode][] = [
  ['SessionClosedError', () => new SessionClosedError('s1'), 'session_closed'],
  ['DaemonShuttingDownError', () => new DaemonShuttingDownError(), 'daemon_shutting_down'],
  ['UnknownHarnessError', () => new UnknownHarnessError('nope'), 'unknown_harness'],
  ['MessageIdAlreadyUsedError', () => new MessageIdAlreadyUsedError('m1'), 'message_id_reused'],
  ['TooManyPendingMessagesError', () => new TooManyPendingMessagesError('s1'), 'too_many_pending'],
  ['SessionReopenError not_closed', () => new SessionReopenError('not_closed', 'x'), 'not_closed'],
  ['SessionReopenError directory_missing', () => new SessionReopenError('directory_missing', 'x'), 'directory_missing'],
  ['SessionReopenError directory_changed', () => new SessionReopenError('directory_changed', 'x'), 'directory_changed'],
  ['SessionReopenError directory_unreadable', () => new SessionReopenError('directory_unreadable', 'x'), 'directory_unreadable'],
  ['SessionReopenError launch_failed', () => new SessionReopenError('launch_failed', 'x'), 'launch_failed'],
  ['ApprovalError not_found', () => new ApprovalError('not_found', 'x'), 'not_found'],
  ['ApprovalError already_resolved', () => new ApprovalError('already_resolved', 'x'), 'already_resolved'],
  ['ModelConfigUnreadableError', () => new ModelConfigUnreadableError('x'), 'config_unreadable'],
  ['ModelConfigReadOnlyError', () => new ModelConfigReadOnlyError('x'), 'config_read_only'],
  ['NoteNotFoundError', () => new NoteNotFoundError('n1'), 'not_found'],
  ['VersionNotFoundError', () => new VersionNotFoundError(3), 'not_found'],
  ['StaleRevisionError', () => new StaleRevisionError(12), 'stale_revision'],
  ['FileBackedNoteError', () => new FileBackedNoteError('n1'), 'file_backed'],
  ['NoteFileUnreadableError', () => new NoteFileUnreadableError('/somewhere/a.md', new Error('EACCES')), 'file_unreadable'],
  ['PathEscapesDocsFolderError', () => new PathEscapesDocsFolderError('/somewhere/../a.md'), 'path_escapes_docs_folder'],
  ['NoteTooLargeError', () => new NoteTooLargeError(2_000_000), 'note_too_large'],
  ['docs ProjectNotFoundError', () => new ProjectNotFoundError('p1'), 'project_not_found'],
  ['StoreNotFoundError', () => new StoreNotFoundError('s1'), 'not_found'],
  ['RowNotFoundError', () => new RowNotFoundError('r1'), 'not_found'],
  ['ViewNotFoundError', () => new ViewNotFoundError('v1'), 'view_not_found'],
  ['DuplicateNameError', () => new DuplicateNameError('Tasks'), 'duplicate_name'],
  ['ConstraintError', () => new ConstraintError('bad'), 'constraint_violation'],
  ['StoreRowCapError', () => new StoreRowCapError('s1', 100), 'row_cap'],
  ['DaemonSetColumnError', () => new DaemonSetColumnError('x'), 'invalid_body'],
  ['InvalidCellValueError', () => new InvalidCellValueError('c1'), 'invalid_body'],
  ['InvalidNameError', () => new InvalidNameError('x'), 'invalid_body'],
  ['InvalidQueryError', () => new InvalidQueryError('x'), 'invalid_body'],
  ['UnknownColumnError', () => new UnknownColumnError(['c1']), 'invalid_body'],
  ['PayloadTooLargeError', () => new PayloadTooLargeError('body exceeds 1 bytes'), 'payload_too_large'],
  ['InvalidJsonBodyError', () => new InvalidJsonBodyError('Unexpected token'), 'invalid_json'],
  ['a SQLite foreign key failure', foreignKeyError, 'project_not_found'],
  ['the stuck-connection error', () => new StuckConnectionError(new Error('disk I/O error')), 'db_stuck'],
  ['an OpenFleetError', () => new OpenFleetError('outside_lineage', 'not your child.'), 'outside_lineage'],
];

describe('describeError: T3 domain classes', () => {
  it.each(domainErrorCodes)('maps %s to its code', (_label, makeError, code) => {
    expect(describeError(makeError()).error).toBe(code);
  });

  it('derives kind and retry from the registry', () => {
    const envelope = describeError(new StaleRevisionError(12));
    expect({ kind: envelope.kind, retry: envelope.retry }).toEqual({ kind: 'conflict', retry: 'after_refresh' });
  });

  it('honours a retry override of the code', () => {
    expect(describeError(new TooManyPendingMessagesError('s1')).retry).toBe('later');
  });

  it('carries an OpenFleetError message, hint and detail through', () => {
    const envelope = describeError(new OpenFleetError('row_cap', 'the store is full.', { hint: 'delete rows', detail: { cap: 100 } }));
    expect(envelope).toMatchObject({ error: 'row_cap', message: 'the store is full.', hint: 'delete rows', detail: { cap: 100 } });
  });

  it('keeps the zod message as detail of an invalid_body, as the REST body does today', () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
    const envelope = describeError((parsed as { error: ZodError }).error);
    expect(envelope).toMatchObject({ error: 'invalid_body', kind: 'invalid_request', retry: 'never', detail: expect.stringContaining('name') });
  });

  it('keeps the json parser message as detail of an invalid_json, as the REST body does today', () => {
    expect(describeError(new InvalidJsonBodyError('Unexpected token }')).detail).toBe('Unexpected token }');
  });

  it('keeps the constraint message as detail of a constraint_violation, as the REST body does today', () => {
    expect(describeError(new ConstraintError('parent row missing')).detail).toBe('parent row missing');
  });

  it('does not log a typed error', () => {
    describeError(new SessionClosedError('s1'));
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('gives a typed error no id', () => {
    expect(describeError(new SessionClosedError('s1')).id).toBeUndefined();
  });
});

describe('describeError: internal errors', () => {
  it('answers internal_error with an 8-hex id and logs one error line carrying that id', () => {
    const envelope = describeError(new Error('sqlite exploded at /secret/place'));
    expect(envelope).toMatchObject({ error: 'internal_error', kind: 'internal', retry: 'later', id: expect.stringMatching(ID_PATTERN) });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]![0])).toContain(envelope.id);
  });

  it('never puts the raw error message or a stack in the envelope', () => {
    const serialized = JSON.stringify(describeError(new Error('sqlite exploded at /secret/place')));
    expect(serialized).not.toContain('sqlite');
    expect(serialized).not.toContain('/secret/place');
    expect(serialized).not.toContain('    at ');
  });

  it('gives the stuck-connection error an id and one error log line, without the SQLite message', () => {
    const envelope = describeError(new StuckConnectionError(new Error('SQLITE_IOERR: disk I/O error')));
    expect(envelope).toMatchObject({ error: 'db_stuck', kind: 'internal', id: expect.stringMatching(ID_PATTERN) });
    expect(JSON.stringify(envelope)).not.toContain('SQLITE');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('logs the label of the site that failed with the id', () => {
    const envelope = describeError(new Error('x'), { where: 'GET /api/sessions → 500' });
    expect(String(errorLog.mock.calls[0]![0])).toContain(`GET /api/sessions → 500 [${envelope.id}]`);
  });
});

describe('describeError: hostile case 9, ids', () => {
  it('mints distinct ids for internal errors thrown in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    const ids = Array.from({ length: 200 }, () => describeError(new Error('same')).id);
    vi.useRealTimers();
    expect(new Set(ids).size).toBe(200);
  });
});

describe('describeError: hostile case 2, huge zod errors', () => {
  it('caps the detail of a ZodError with 10 000 issues at 2 KiB serialized', () => {
    const issues = Array.from({ length: 10_000 }, (_, index) => ({ code: 'custom' as const, path: ['items', index], message: `bad item ${index}` }));
    const envelope = describeError(new ZodError(issues));
    expect(Buffer.byteLength(JSON.stringify(envelope.detail))).toBeLessThanOrEqual(2048);
    expect(envelope.error).toBe('invalid_body');
  });

  it('marks a cut detail with an ellipsis', () => {
    const issues = Array.from({ length: 10_000 }, (_, index) => ({ code: 'custom' as const, path: [index], message: 'bad' }));
    expect(String(describeError(new ZodError(issues)).detail)).toMatch(/…$/);
  });
});

describe('describeError: hostile case 3, strange thrown values', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'plain string failure'],
    ['a number', 42],
    ['a plain object', { message: 'not an Error' }],
  ])('answers internal_error for a thrown %s without leaking it', (_label, thrown) => {
    const envelope = describeError(thrown);
    expect(envelope).toMatchObject({ error: 'internal_error', id: expect.stringMatching(ID_PATTERN) });
    expect(JSON.stringify(envelope)).not.toContain('plain string failure');
  });

  it('survives an error whose cause is circular', () => {
    const error = new Error('outer') as Error & { cause?: unknown };
    error.cause = error;
    expect(describeError(error).error).toBe('internal_error');
  });

  it('survives an error whose stack getter throws', () => {
    const error = new Error('hostile stack');
    Object.defineProperty(error, 'stack', { get() { throw new Error('stack getter'); } });
    expect(describeError(error).error).toBe('internal_error');
  });

  it('survives an OpenFleetError whose detail is circular', () => {
    const detail: Record<string, unknown> = {};
    detail.self = detail;
    const envelope = describeError(new OpenFleetError('row_cap', 'full.', { detail }));
    expect(envelope.error).toBe('row_cap');
  });
});

describe('describeError: hostile case 4, paths and control characters', () => {
  const home = homedir();

  it('never puts the directory path in a directory_missing message, even with a newline in the name', () => {
    const directory = `${home}/proj\nINJECTED`;
    const envelope = describeError(new SessionReopenError('directory_missing', `directory ${directory} no longer exists`));
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain('INJECTED');
  });

  it('never puts the path in the message of a NoteFileUnreadableError', () => {
    const envelope = describeError(new NoteFileUnreadableError(`${home}/docs/secret.md`, new Error('EACCES')));
    expect(JSON.stringify(envelope)).not.toContain(home);
    expect(JSON.stringify(envelope)).not.toContain('secret.md');
  });

  it('shortens the user home to ~ in a carried message', () => {
    const envelope = describeError(new OpenFleetError('directory_in_use', `busy: ${home}/work/app`));
    expect(envelope.message).toBe('busy: ~/work/app');
  });
});

describe('describeError: hostile case 1, message hygiene and caps', () => {
  const hostile = new OpenFleetError('row_cap', `token Bearer abc123_-XYZ at /hooks/secretToken9 \u001b[31mred\u0000nul ${'A'.repeat(50 * 1024)}`, {
    hint: `h${'B'.repeat(50 * 1024)}`,
    detail: `d${'C'.repeat(50 * 1024)}`,
  });

  it('caps message at 300 chars, hint at 200 and detail at 2 KiB', () => {
    const envelope = describeError(hostile);
    expect(envelope.message.length).toBeLessThanOrEqual(300);
    expect(envelope.hint!.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(envelope.detail))).toBeLessThanOrEqual(2048);
  });

  it('strips control characters', () => {
    expect(describeError(hostile).message).not.toMatch(/\p{Cc}/u);
  });

  it('redacts a bearer token and a hook token', () => {
    const envelope = describeError(new OpenFleetError('row_cap', 'call with Bearer abc123_-XYZ or POST /hooks/secretToken9 now.'));
    expect(envelope.message).not.toContain('abc123_-XYZ');
    expect(envelope.message).not.toContain('secretToken9');
  });
});
