import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ZodError, z } from 'zod';
import { ERROR_CODES, OpenFleetError, type ErrorCode } from '@openfleet/shared';
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
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError, UnknownColumnReferenceError } from '../stores/dataStoreRepository.js';
import {
  ConstraintError, DaemonSetColumnError, DuplicateIdError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError, InvalidNameError, InvalidQueryError,
  InvalidViewConfigError, ReferencedRecordMissingError, StoreHasRowsError, StoreRowCapError, ViewNotFoundError,
} from '../stores/dataStoreService.js';
import { NoteIsNotFileBackedError, ProjectHasNoDocsFolderError } from '../notes/docsFolderService.js';
import { SessionHasNoProjectError, SessionNotFoundForHandoffError } from '../notes/handoffService.js';
import { SectionError } from '../notes/noteSections.js';
import { WorktreeError } from '../git/worktrees.js';
import { WorkingStateTooLargeError } from '../workingState/workingStateService.js';
import { describeError } from './describeError.js';

const ID_PATTERN = /^[0-9a-f]{8}$/;

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
  ['UnknownColumnReferenceError', () => new UnknownColumnReferenceError(['c1']), 'invalid_body'],
  ['ReferencedRecordMissingError', () => new ReferencedRecordMissingError('parent row missing'), 'constraint_violation'],
  ['StoreHasRowsError', () => new StoreHasRowsError('s1', 3), 'store_has_rows'],
  ['InvalidViewConfigError', () => new InvalidViewConfigError('Invalid view config'), 'invalid_body'],
  ['InvalidColumnDefinitionError', () => new InvalidColumnDefinitionError('Option ids must be unique'), 'invalid_body'],
  ['InvalidActorError', () => new InvalidActorError('Actor kind must be human, agent or trigger'), 'invalid_body'],
  ['DuplicateIdError', () => new DuplicateIdError('That id is already in use'), 'duplicate_id'],
  ['SectionError', () => new SectionError('section "Plan" not found'), 'invalid_body'],
  ['WorkingStateTooLargeError', () => new WorkingStateTooLargeError(9000, 8000), 'state_too_large'],
  ['SessionNotFoundForHandoffError', () => new SessionNotFoundForHandoffError('s1'), 'session_not_found'],
  ['SessionHasNoProjectError', () => new SessionHasNoProjectError('s1'), 'project_not_found'],
  ['ProjectHasNoDocsFolderError', () => new ProjectHasNoDocsFolderError('p1'), 'no_docs_folder'],
  ['NoteIsNotFileBackedError', () => new NoteIsNotFileBackedError('n1'), 'not_file_backed'],
  ['WorktreeError invalid_branch', () => new WorktreeError('invalid_branch', 'invalid branch name: a b'), 'invalid_body'],
  ['WorktreeError git_failed', () => new WorktreeError('git_failed', 'fatal: /w/a is not a repository'), 'internal_error'],
  ['WorktreeError exists',() => new WorktreeError('exists', 'worktree already exists: /w/a'), 'duplicate_name'],
  ['PayloadTooLargeError', () => new PayloadTooLargeError('body exceeds 1 bytes'), 'payload_too_large'],
  ['InvalidJsonBodyError', () => new InvalidJsonBodyError('Unexpected token'), 'invalid_json'],
  ['a SQLite foreign key failure', foreignKeyError, 'project_not_found'],
  ['the stuck-connection error', () => new StuckConnectionError(new Error('disk I/O error')), 'db_stuck'],
  ['an OpenFleetError', () => new OpenFleetError('outside_lineage', 'not your child.'), 'outside_lineage'],
];

describe('describeError: every Error subclass of core is mapped or internal on purpose', () => {
  const CORE_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
  const ERROR_SUBCLASS_DECLARATION = /class (\w+) extends \w*Error\b/g;
  // Boot-time failures answered by bootFailure.ts, and a write failure whose cause is SQL: none reaches a caller as itself.
  const INTERNAL_ON_PURPOSE = ['ConfigFileError', 'DatabaseOpenError', 'PortInUseError', 'DataStoreWriteError'];

  const declaredErrorClasses = (): string[] =>
    readdirSync(CORE_DIRECTORY, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) => [...readFileSync(`${CORE_DIRECTORY}${file}`, 'utf8').matchAll(ERROR_SUBCLASS_DECLARATION)].map(([, name]) => name!));

  it('finds the error classes declared in core', () => {
    expect(declaredErrorClasses().length).toBeGreaterThan(40);
  });

  it('leaves no declared error class out of the mapping table', () => {
    const mappedClasses = new Set(domainErrorCodes.map(([, makeError]) => (makeError() as Error).constructor.name));
    const unlisted = declaredErrorClasses().filter((name) => !mappedClasses.has(name) && !INTERNAL_ON_PURPOSE.includes(name));

    expect(unlisted).toEqual([]);
  });
});

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

describe('describeError: every domain class', () => {
  const isInternalCode = (code: ErrorCode) => ERROR_CODES[code].kind === 'internal';
  const typedCases = domainErrorCodes.filter(([, , code]) => !isInternalCode(code));
  const internalCases = domainErrorCodes.filter(([, , code]) => isInternalCode(code));

  it.each(typedCases)('answers %s with no id and no log line', (_label, makeError) => {
    const envelope = describeError(makeError());

    expect(envelope.id).toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each(internalCases)('answers %s with an 8-hex id and exactly one log line that carries it', (_label, makeError) => {
    const envelope = describeError(makeError());

    expect(envelope.id).toMatch(ID_PATTERN);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]![0])).toContain(envelope.id);
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

describe('describeError: hostile case 1, secrets and paths in every field', () => {
  const carrying = (text: string) => new OpenFleetError('row_cap', text, { hint: text, detail: text });
  const detailCarrying = (detail: unknown) => new OpenFleetError('row_cap', 'the store is full.', { detail });

  it.each(['Bearer', 'bearer', 'BEARER'])('redacts a %s token in the message, the hint and the detail', (scheme) => {
    const serialized = JSON.stringify(describeError(carrying(`call with ${scheme} s3cr3t.tok-EN now`)));

    expect(serialized).not.toContain('s3cr3t.tok-EN');
  });

  it('redacts a hook token in the message, the hint and the detail', () => {
    const serialized = JSON.stringify(describeError(carrying('posted to /hooks/h00kT0ken9 just now')));

    expect(serialized).not.toContain('h00kT0ken9');
  });

  it('redacts a secret inside a structured detail past 2 KiB', () => {
    const serialized = JSON.stringify(describeError(detailCarrying({ header: 'Bearer s3cr3t.tok-EN', pad: 'p'.repeat(4096) })));

    expect(serialized).not.toContain('s3cr3t.tok-EN');
  });

  it('redacts a secret inside a structured detail that fits in 2 KiB', () => {
    const { detail } = describeError(detailCarrying({ header: 'Bearer s3cr3t.tok-EN', nested: [{ url: 'POST /hooks/h00kT0ken9' }] }));

    expect(JSON.stringify(detail)).not.toMatch(/s3cr3t|h00kT0ken9/);
  });

  it.each(['authorization', 'token', 'accessToken', 'client_secret', 'password'])('masks the value under the key %s of a small structured detail', (key) => {
    const { detail } = describeError(detailCarrying({ [key]: 'plain-looking-value-42', kept: 'visible' }));

    expect(detail).toEqual({ [key]: '***', kept: 'visible' });
  });

  it('shortens the user home inside a structured detail that fits in 2 KiB', () => {
    const { detail } = describeError(detailCarrying({ path: `${homedir()}/work/app` }));

    expect(detail).toEqual({ path: '~/work/app' });
  });

  it('keeps a structured detail that carries nothing sensitive as it is', () => {
    expect(describeError(detailCarrying({ currentRev: 12 })).detail).toEqual({ currentRev: 12 });
  });

  it.each([
    ['Bearer:tok', 'call with Bearer:t0k3nVALUE now'],
    ['Bearer=tok', 'call with Bearer=t0k3nVALUE now'],
    ['a token query value', 'GET /x?token=t0k3nVALUE&page=2'],
    ['an access_token query value', 'GET /x?page=2&access_token=t0k3nVALUE'],
    ['an encoded hook path', 'posted to %2Fhooks%2Ft0k3nVALUE just now'],
    ['an upper-case hook path', 'posted to /HOOKS/t0k3nVALUE just now'],
  ])('redacts %s in the message, the hint and the detail', (_label, text) => {
    const serialized = JSON.stringify(describeError(carrying(text)));

    expect(serialized).not.toContain('t0k3nVALUE');
  });

  it('keeps the other query parameters when it redacts a token value', () => {
    expect(describeError(carrying('GET /x?token=t0k3nVALUE&page=2')).message).toContain('page=2');
  });

  it('strips NUL and escape characters from a string detail', () => {
    const { detail } = describeError(detailCarrying('a\u0000b\u001b[31mc'));

    expect(String(detail)).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('shortens an OpenFleet home that sits outside the user home, in the message, the hint and the detail', () => {
    vi.stubEnv('OPENFLEET_HOME', '/srv/openfleet-home-hostile');

    const serialized = JSON.stringify(describeError(carrying('failed reading /srv/openfleet-home-hostile/openfleet.db')));

    expect(serialized).not.toContain('/srv/openfleet-home-hostile');
  });
});

describe('describeError: hostile case 1, message hygiene and caps', () => {
  const hostile = new OpenFleetError('row_cap', `token Bearer abc123_-XYZ at /hooks/secretToken9 \u001b[31mred\u0000nul ${'A'.repeat(50 * 1024)}`, {
    hint: `h${'B'.repeat(50 * 1024)}`,
    detail: `d${'C'.repeat(50 * 1024)}`,
  });

  it('caps message at 300 chars, hint at 200 and detail at 2 KiB', () => {
    const envelope = describeError(hostile);
    expect(Array.from(envelope.message)).toHaveLength(300);
    expect(Array.from(envelope.hint!)).toHaveLength(200);
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

describe('describeError: path shortening boundaries', () => {
  const home = homedir();
  const messageOf = (text: string) => describeError(new OpenFleetError('directory_in_use', text)).message;

  it('does not shorten a path that only starts with the home prefix', () => {
    expect(messageOf(`busy: ${home}by/x`)).toBe(`busy: ${home}by/x`);
  });

  it('shortens the home itself when the text ends there', () => {
    expect(messageOf(`busy: ${home}`)).toBe('busy: ~');
  });

  it('leaves unrelated text alone when OPENFLEET_HOME is a short relative path', () => {
    vi.stubEnv('OPENFLEET_HOME', 'ab');

    expect(messageOf('about the table ab and cab')).toBe('about the table ab and cab');
  });
});

describe('describeError: text the desktop renders', () => {
  const HIDDEN_CHARACTERS = '‮‪⁦​‍﻿  ';
  const carrying = (text: string) => new OpenFleetError('row_cap', text, { hint: text, detail: text });

  it('removes bidi controls, zero-width characters and line separators from the message, the hint and a string detail', () => {
    const envelope = describeError(carrying(`x${HIDDEN_CHARACTERS}evil${HIDDEN_CHARACTERS}line`));

    expect([envelope.message, envelope.hint, envelope.detail]).toEqual(['xevilline', 'xevilline', 'xevilline']);
  });

  it('removes them from the strings of a structured detail', () => {
    const { detail } = describeError(new OpenFleetError('row_cap', 'full.', { detail: { name: `a${HIDDEN_CHARACTERS}b` } }));

    expect(detail).toEqual({ name: 'ab' });
  });

  it('counts the 300-char cap in code points, so 400 emoji keep 299 emoji and an ellipsis', () => {
    const { message } = describeError(new OpenFleetError('row_cap', '😀'.repeat(400)));

    expect(Array.from(message)).toHaveLength(300);
    expect(message.endsWith('…')).toBe(true);
  });

  it('keeps a message of 250 emoji whole, since 250 code points fit in 300', () => {
    const { message } = describeError(new OpenFleetError('row_cap', '😀'.repeat(250)));

    expect(message).toBe('😀'.repeat(250));
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const { message } = describeError(new OpenFleetError('row_cap', `a${'😀'.repeat(400)}`));

    expect(message).not.toMatch(LONE_SURROGATE);
  });
});

describe('describeError: a detail is serialized once', () => {
  it('answers a body that survives two serializations when the detail has a stateful toJSON', () => {
    let calls = 0;
    const statefulDetail = { toJSON: () => { calls += 1; if (calls > 1) throw new Error('second serialization'); return { currentRev: 12 }; } };

    const envelope = describeError(new OpenFleetError('row_cap', 'full.', { detail: statefulDetail }));

    expect(JSON.parse(JSON.stringify(envelope)).detail).toEqual({ currentRev: 12 });
    expect(JSON.parse(JSON.stringify(envelope)).detail).toEqual({ currentRev: 12 });
  });
});

describe('describeError: an internal-kind OpenFleetError', () => {
  const sqlLeak = 'SELECT * FROM x in ~/p';

  it('answers the generic message with an id instead of forwarding its own message, hint and detail', () => {
    const envelope = describeError(new OpenFleetError('internal_error', sqlLeak, { hint: 'try SELECT again', detail: { sql: sqlLeak } }));

    expect(JSON.stringify(envelope)).not.toContain('SELECT');
    expect(envelope).toMatchObject({ error: 'internal_error', message: 'the daemon hit an unexpected error.', id: expect.stringMatching(ID_PATTERN) });
  });

  it('logs the real message with the id', () => {
    const error = new OpenFleetError('launch_failed', sqlLeak);

    const envelope = describeError(error);

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]![0])).toContain(envelope.id);
    expect(errorLog.mock.calls[0]![1]).toBe(error);
  });
});
