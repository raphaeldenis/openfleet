import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, HTTP_STATUS_BY_KIND, retryOf, type ErrorCode } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { forceNdjsonLogging } from '../forceNdjsonLogging.testkit.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { createMcpHandler } from '../mcp/mcpServer.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService, NoteFileUnreadableError, PathEscapesDocsFolderError } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteTooLargeError, NoteService, StaleRevisionError } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DaemonShuttingDownError, SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { ConstraintError, DataStoreService, StoreRowCapError } from '../stores/dataStoreService.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { Router } from './router.js';
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };
const NO_TOKEN = { 'content-type': 'application/json' };
const DIRECTORY_MARKER = 'hostile-dir-marker';

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let managers: ManagerService;
let pulseScheduler: PulseScheduler;
let harness: FakeHarness;
let scratch: string;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  forceNdjsonLogging();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  scratch = mkdtempSync(join(tmpdir(), 'of-golden-'));
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });
  const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: join(scratch, 'state'), maxBytes: 6144 });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: join(scratch, 'config.json'),
    notes, noteRepo, docs, stores, storeRepo, projects, workingStates, e2eRoutes: true,
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, projects, workingStates }),
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

interface Answer { status: number; headers: Headers; body: Record<string, any> }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = ADMIN): Promise<Answer> {
  const response = await fetch(`${server.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
}

const openSession = () => sessions.create({ directory: scratch, name: 'Gimli', harness: 'fake', emoji: '⛏️' });
async function closedSession() {
  const session = await openSession();
  await sessions.close(session.id);
  return session;
}
const concretePath = (pattern: string) => pattern.replace(/:[a-zA-Z]+/g, 'some-id');

function everyHandlerThrows(error: unknown): void {
  vi.spyOn(Router.prototype, 'match').mockReturnValue({ handler: () => { throw error; }, params: {} });
}

function rawGet(path: string): Promise<{ status: number; body: Record<string, any> }> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: ADMIN }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Expected { status: number; error: ErrorCode; currentRev?: number }
interface Scenario { name: string; expected: Expected; act: () => Promise<Answer> }

// Every error answer a real request can provoke, before and after ERR-02: `error` and the status are the wire contract.
const REAL_REQUEST_SCENARIOS: Scenario[] = [
  { name: 'an unknown route', expected: { status: 404, error: 'not_found' }, act: () => call('GET', '/nope') },
  { name: 'a malformed percent escape in a hook token', expected: { status: 404, error: 'not_found' }, act: () => call('POST', '/hooks/%E0%A4%A', {}) },
  { name: 'an mcp call with an unknown bearer', expected: { status: 401, error: 'unauthorized' }, act: () => call('POST', '/mcp', {}, { authorization: 'Bearer nope', 'content-type': 'application/json' }) },
  { name: 'a malformed request url', expected: { status: 400, error: 'invalid_url' }, act: async () => { const { status, body } = await rawGet('//'); return { status, body, headers: new Headers() }; } },
  { name: 'a body that is not JSON', expected: { status: 400, error: 'invalid_json' }, act: async () => {
    const response = await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: ADMIN, body: '{' });
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
  } },
  { name: 'a body over the cap', expected: { status: 413, error: 'payload_too_large' }, act: () => call('POST', '/api/sessions', { pad: 'x'.repeat(1024 * 1024 + 1) }) },
  { name: 'a body that fails its schema', expected: { status: 400, error: 'invalid_body' }, act: () => call('POST', '/api/sessions', { name: 5 }) },
  { name: 'an unknown harness', expected: { status: 400, error: 'unknown_harness' }, act: () => call('POST', '/api/sessions', { directory: scratch, name: 'x', harness: 'claude-cli' }) },
  { name: 'a message to a closed session', expected: { status: 409, error: 'session_closed' }, act: async () => call('POST', `/api/sessions/${(await closedSession()).id}/messages`, { body: 'hi' }) },
  { name: 'a permission mode on a closed session', expected: { status: 409, error: 'session_closed' }, act: async () => call('POST', `/api/sessions/${(await closedSession()).id}/permission-mode`, { mode: 'plan' }) },
  { name: 'a model switch on a closed session', expected: { status: 409, error: 'session_closed' }, act: async () => call('POST', `/api/sessions/${(await closedSession()).id}/model`, { model: 'sonnet' }) },
  { name: 'a reopen of a session that is not closed', expected: { status: 409, error: 'not_closed' }, act: async () => call('POST', `/api/sessions/${(await openSession()).id}/reopen`) },
  { name: 'a reopen whose directory is gone', expected: { status: 409, error: 'directory_missing' }, act: async () => {
    const session = await closedSession();
    rmSync(scratch, { recursive: true, force: true });
    return call('POST', `/api/sessions/${session.id}/reopen`);
  } },
  { name: 'a reopen whose launch throws', expected: { status: 500, error: 'launch_failed' }, act: async () => {
    const session = await closedSession();
    vi.spyOn(harness, 'start').mockImplementation(() => { throw new Error('spawn boom'); });
    return call('POST', `/api/sessions/${session.id}/reopen`);
  } },
  { name: 'a pulse on a manager whose session is closed', expected: { status: 409, error: 'session_closed' }, act: () => {
    vi.spyOn(managers, 'get').mockReturnValue({} as never);
    vi.spyOn(pulseScheduler, 'pulseNow').mockReturnValue(undefined);
    return call('POST', '/api/managers/m1/pulse');
  } },
  { name: 'a create while the daemon shuts down', expected: { status: 503, error: 'daemon_shutting_down' }, act: async () => {
    await sessions.closeAll();
    return call('POST', '/api/sessions', { directory: scratch, name: 'x', harness: 'fake' });
  } },
  { name: 'a decision on an unknown approval', expected: { status: 404, error: 'not_found' }, act: () => call('POST', '/api/approvals/some-id/decide', { behavior: 'allow' }) },
  { name: 'a models save onto an unreadable config', expected: { status: 409, error: 'config_unreadable' }, act: () => {
    writeFileSync(join(scratch, 'config.json'), '{ not json');
    return call('PUT', '/api/models', { haiku: 'claude-haiku-4-5-20251001' });
  } },
  { name: 'a note in an unknown project', expected: { status: 404, error: 'project_not_found' }, act: () => call('POST', '/api/notes', { projectId: 'ghost', title: 'T', bodyMd: 'b' }) },
  { name: 'an unknown note', expected: { status: 404, error: 'not_found' }, act: () => call('GET', '/api/notes/ghost?projectId=p1') },
  { name: 'a note edited from a stale revision', expected: { status: 409, error: 'stale_revision', currentRev: 2 }, act: async () => {
    const note = (await call('POST', '/api/notes', { projectId: 'p1', title: 'T', bodyMd: 'a' })).body;
    await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'b' });
    return call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'c' });
  } },
  { name: 'a search with too many terms', expected: { status: 400, error: 'invalid_body' }, act: () => call('GET', `/api/notes/search?projectId=p1&q=${Array.from({ length: 60 }, (_, i) => `w${i}`).join('+')}`) },
  { name: 'a data store in an unknown project', expected: { status: 404, error: 'project_not_found' }, act: () => call('POST', '/api/data-stores', { projectId: 'ghost', displayName: 'S' }) },
  { name: 'an unknown data store', expected: { status: 404, error: 'not_found' }, act: () => call('GET', '/api/data-stores/ghost?projectId=p1') },
  { name: 'a duplicate data store name', expected: { status: 409, error: 'duplicate_name' }, act: async () => {
    await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'Same' });
    return call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'Same' });
  } },
  { name: 'a working state that does not exist', expected: { status: 404, error: 'no_state' }, act: async () => call('GET', `/api/sessions/${(await openSession()).id}/working-state`) },
];

// Typed errors that need an internal state a fixture cannot reach, thrown through the real catch-all.
const THROWN_ERROR_SCENARIOS: { name: string; thrown: () => unknown; expected: Expected }[] = [
  { name: 'a constraint violation (moved from 409 to 400: decision D10)', thrown: () => new ConstraintError('violates'), expected: { status: 400, error: 'constraint_violation' } },
  { name: 'a row cap', thrown: () => new StoreRowCapError('s1', 10000), expected: { status: 413, error: 'row_cap' } },
  { name: 'an oversized note', thrown: () => new NoteTooLargeError(2_000_000), expected: { status: 413, error: 'note_too_large' } },
  { name: 'a path outside the docs folder', thrown: () => new PathEscapesDocsFolderError('x'), expected: { status: 409, error: 'path_escapes_docs_folder' } },
  { name: 'an unreadable note file', thrown: () => new NoteFileUnreadableError('/Users/someone/docs/a.md', new Error('EACCES')), expected: { status: 409, error: 'file_unreadable' } },
  { name: 'a stale revision', thrown: () => new StaleRevisionError(7), expected: { status: 409, error: 'stale_revision', currentRev: 7 } },
  { name: 'a daemon that shuts down', thrown: () => new DaemonShuttingDownError(), expected: { status: 503, error: 'daemon_shutting_down' } },
];

describe('golden: every error answer of a real request keeps its wire value and gains the envelope', () => {
  it.each(REAL_REQUEST_SCENARIOS)('$name', async ({ act, expected }) => {
    const { status, body } = await act();
    expect({ status, error: body.error, ...(expected.currentRev !== undefined && { currentRev: body.currentRev }) }).toEqual(expected);
    const { kind } = ERROR_CODES[expected.error];
    expect({ kind: body.kind, retry: body.retry, message: typeof body.message }).toEqual({ kind, retry: retryOf(expected.error), message: 'string' });
    expect(status).toBe(HTTP_STATUS_BY_KIND[kind]);
  });

  it('keeps currentRev at the top level of a stale_revision body and in its detail', async () => {
    const stale = REAL_REQUEST_SCENARIOS.find(({ name }) => name.includes('stale'))!;
    const { body } = await stale.act();
    expect({ top: body.currentRev, detail: body.detail }).toEqual({ top: 2, detail: { currentRev: 2 } });
  });

  it('gives a reopen that failed to launch an internal envelope: id, header and the same id in the log', async () => {
    const session = await closedSession();
    vi.spyOn(harness, 'start').mockImplementation(() => { throw new Error('spawn boom'); });
    const { body, headers } = await call('POST', `/api/sessions/${session.id}/reopen`);
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(headers.get('x-openfleet-error-id')).toBe(body.id);
    expect(errorLog.mock.calls.filter((line: unknown[]) => String(line[0]).includes(body.id))).toHaveLength(1);
  });

  it('answers a typed error a route used to catch itself with no id and no header', async () => {
    const closed = await closedSession();
    const { body, headers } = await call('POST', `/api/sessions/${closed.id}/messages`, { body: 'hi' });
    expect({ id: body.id, header: headers.get('x-openfleet-error-id') }).toEqual({ id: undefined, header: null });
  });
});

describe('golden: typed errors thrown inside a route answer their code, status, kind and retry', () => {
  it.each(THROWN_ERROR_SCENARIOS)('$name', async ({ thrown, expected }) => {
    everyHandlerThrows(thrown());
    const { status, body } = await call('GET', '/api/sessions');
    expect({ status, error: body.error, ...(expected.currentRev !== undefined && { currentRev: body.currentRev }) }).toEqual(expected);
    const { kind } = ERROR_CODES[expected.error];
    expect({ kind: body.kind, retry: body.retry }).toEqual({ kind, retry: retryOf(expected.error) });
  });
});

describe('golden: the answers generated from server.routes', () => {
  const apiRoutes = () => server.routes.filter(({ path }) => path.startsWith('/api/'));

  it('answers 401 unauthorized with kind and retry on every /api route without the admin token', async () => {
    const answers = await Promise.all(apiRoutes().map(async ({ method, path }) => ({
      route: `${method} ${path}`, ...(await call(method, concretePath(path), method === 'GET' ? undefined : {}, NO_TOKEN)),
    })));
    const drifted = answers.filter(({ status, body }) => status !== 401 || body.error !== 'unauthorized' || body.kind !== 'unauthorized' || body.retry !== 'never' || typeof body.message !== 'string');
    expect(drifted.map(({ route }) => route)).toEqual([]);
  });

  it('answers 404 not_found with kind and retry on every session and manager route for an unknown id', async () => {
    const idRoutes = apiRoutes().filter(({ path }) => path.startsWith('/api/sessions/:id') || path === '/api/managers/:id/pulse');
    const answers = await Promise.all(idRoutes.map(async ({ method, path }) => ({
      route: `${method} ${path}`, ...(await call(method, concretePath(path), method === 'GET' ? undefined : {})),
    })));
    const drifted = answers.filter(({ status, body }) => status !== 404 || body.error !== 'not_found' || body.kind !== 'not_found' || body.retry !== 'never');
    expect({ count: idRoutes.length > 10, drifted: drifted.map(({ route }) => route) }).toEqual({ count: true, drifted: [] });
  });

  it('answers 500 internal_error with an 8-hex id on every route when the handler throws an unexpected error', async () => {
    everyHandlerThrows(new Error('boom-marker'));
    const answers = await Promise.all(apiRoutes().map(async ({ method, path }) => ({ route: `${method} ${path}`, ...(await call(method, concretePath(path), method === 'GET' ? undefined : {})) })));
    const drifted = answers.filter(({ status, body }) => status !== 500 || body.error !== 'internal_error' || !/^[0-9a-f]{8}$/.test(String(body.id)));
    expect(drifted.map(({ route }) => route)).toEqual([]);
  });
});

describe('golden: no body carries a path, SQL or a token (hostile cases 1 to 4 through real routes)', () => {
  it('keeps the home directory and the session directory out of a reopen refusal', async () => {
    const hostileDirectory = join(scratch, `${DIRECTORY_MARKER}\nsecond-line`);
    mkdirSync(hostileDirectory);
    const session = await sessions.create({ directory: hostileDirectory, name: 'Hostile', harness: 'fake', emoji: '⛏️' });
    await sessions.close(session.id);
    rmSync(hostileDirectory, { recursive: true, force: true });
    const { status, body } = await call('POST', `/api/sessions/${session.id}/reopen`);
    expect({ status, error: body.error }).toEqual({ status: 409, error: 'directory_missing' });
    expect(JSON.stringify(body)).not.toContain(DIRECTORY_MARKER);
    expect(JSON.stringify(body)).not.toContain(tmpdir());
  });

  it('keeps a bearer, a hook url and a control character out of the body of a thrown error', async () => {
    everyHandlerThrows(new Error('Bearer admin-secret-123 /hooks/tok123abc \u0000\u001b[31m'));
    const text = JSON.stringify((await call('GET', '/api/sessions')).body);
    expect(text).not.toMatch(/admin-secret-123|tok123abc|\\u0000|\\u001b/);
  });

  it('caps a 10 000-issue zod failure at 2 KiB of detail', async () => {
    const rows = Array.from({ length: 10_000 }, () => ({ bad: 1 }));
    const { status, body } = await call('POST', '/api/data-stores/some-id/rows', { projectId: 'p1', rows });
    expect(status).toBe(400);
    expect(Buffer.byteLength(JSON.stringify(body.detail ?? ''))).toBeLessThanOrEqual(2048);
  });

  it.each([['undefined', undefined], ['a string', 'plain string'], ['an object', { cause: undefined }]])('answers a thrown %s with a clean internal_error', async (_label, thrown) => {
    everyHandlerThrows(thrown);
    const { status, body } = await call('GET', '/api/sessions');
    expect({ status, error: body.error }).toEqual({ status: 500, error: 'internal_error' });
  });
});
