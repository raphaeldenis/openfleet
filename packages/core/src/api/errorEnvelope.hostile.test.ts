import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFleetError, type ErrorCode } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { StuckConnectionError } from '../db/transaction.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionReopenError, SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { Router } from './router.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';
const ID_PATTERN = /^[0-9a-f]{8}$/;
const MARKER = 'hostile-marker-9137';
const ANSWER_DEADLINE_MS = 3000;

let server: Awaited<ReturnType<typeof startServer>>;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(mkdtempSync(join(tmpdir(), 'of-unused-')), 'config.json'), e2eRoutes: true,
    notes, noteRepo, docs, stores, storeRepo, projects,
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const concretePath = (pattern: string) => pattern.replace(/:[a-zA-Z]+/g, 'some-id');

function makeEveryHandlerThrow(error: unknown) {
  vi.spyOn(Router.prototype, 'match').mockReturnValue({ handler: () => { throw error; }, params: {} });
}

const callRoute = ({ method, path }: { method: string; path: string }) =>
  fetch(`${server.url}${concretePath(path)}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
    signal: AbortSignal.timeout(ANSWER_DEADLINE_MS),
  });

const getSessions = () => callRoute({ method: 'GET', path: '/api/sessions' });

describe('T2 on every REST route, notes, projects and tables included', () => {
  it('registers the notes, projects and tables routes next to the session routes', () => {
    const paths = server.routes.map(({ path }) => path);

    expect(paths.some((path) => path.startsWith('/api/notes'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/api/projects'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/api/data-stores'))).toBe(true);
  });

  it('answers 500 internal_error with an 8-hex id in body and header on every one of them', async () => {
    makeEveryHandlerThrow(new Error(MARKER));
    const routes = server.routes.filter(({ path }) => path.startsWith('/api/'));

    const answers = await Promise.all(routes.map(async (route) => {
      const response = await callRoute(route);
      const body = await response.json() as Record<string, unknown>;
      return { route, status: response.status, error: body.error, idInBody: body.id, idInHeader: response.headers.get('x-openfleet-error-id') };
    }));

    const failures = answers.filter(({ status, error, idInBody, idInHeader }) =>
      status !== 500 || error !== 'internal_error' || !ID_PATTERN.test(String(idInBody)) || idInHeader !== idInBody);
    expect(failures).toEqual([]);
  });
});

describe('hostile thrown values reach the caller as a clean 500', () => {
  const circularCause = () => { const error = new Error(MARKER) as Error & { cause?: unknown }; error.cause = error; return error; };
  const throwingStack = () => { const error = new Error(MARKER); Object.defineProperty(error, 'stack', { get() { throw new Error('stack getter'); } }); return error; };
  const throwingMessage = () => { const error = new Error('x'); Object.defineProperty(error, 'message', { get() { throw new Error('message getter'); } }); return error; };

  it.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['a string', () => MARKER],
    ['a number', () => 42],
    ['a symbol', () => Symbol(MARKER)],
    ['an error with a circular cause', circularCause],
    ['an error whose stack getter throws', throwingStack],
    ['an error whose message getter throws', throwingMessage],
    ['a proxy that throws on every read', () => new Proxy({}, { get() { throw new Error('proxy'); } })],
  ])('answers 500 internal_error with an id for %s', async (_label, makeThrown) => {
    makeEveryHandlerThrow(makeThrown());

    const response = await getSessions();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ error: 'internal_error', kind: 'internal', retry: 'later', id: expect.stringMatching(ID_PATTERN) });
    expect(text).not.toContain(MARKER);
  });

  it('still answers 500 when the error log itself throws', async () => {
    errorLog.mockImplementation(() => { throw new Error('EPIPE: stdout closed'); });
    makeEveryHandlerThrow(new Error(MARKER));

    const response = await getSessions();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });

  it('still answers 500 when an OpenFleetError carries a code missing from the registry', async () => {
    makeEveryHandlerThrow(new OpenFleetError('code_from_the_future' as ErrorCode, MARKER));

    const response = await getSessions();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'internal_error', kind: 'internal' });
  });

  it('gives fifty simultaneous failures fifty distinct ids', async () => {
    makeEveryHandlerThrow(new Error(MARKER));

    const answers = await Promise.all(Array.from({ length: 50 }, () => getSessions()));
    const ids = answers.map((response) => response.headers.get('x-openfleet-error-id'));

    expect(new Set(ids).size).toBe(50);
  });
});

describe('the error id header on every internal code', () => {
  it.each([
    ['db_stuck', () => new StuckConnectionError(new Error('SQLITE_IOERR'))],
    ['launch_failed', () => new SessionReopenError('launch_failed', MARKER)],
    ['an OpenFleetError internal_error', () => new OpenFleetError('internal_error', 'boom.')],
  ])('carries the id of %s in the header, equal to the body id', async (_label, makeThrown) => {
    makeEveryHandlerThrow(makeThrown());

    const response = await getSessions();
    const body = await response.json() as { id?: string };

    expect(response.status).toBe(500);
    expect(body.id).toMatch(ID_PATTERN);
    expect(response.headers.get('x-openfleet-error-id')).toBe(body.id);
  });
});

describe('a hostile message on a typed error', () => {
  const hostileMessage = `Authorization: Bearer abc.DEF-123 at /hooks/tok3n9 \u001b[31mred\u0000nul ${'A'.repeat(50 * 1024)}`;

  it('leaves a capped, clean body: no secret, no control character, under 4 KiB', async () => {
    makeEveryHandlerThrow(new OpenFleetError('row_cap', hostileMessage, { hint: hostileMessage, detail: hostileMessage }));

    const response = await getSessions();
    const text = await response.text();
    const body = JSON.parse(text) as { message: string; hint: string; detail: string };

    expect(response.status).toBe(413);
    expect(text).not.toContain('abc.DEF-123');
    expect(text).not.toContain('tok3n9');
    expect([body.message, body.hint, body.detail].join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
  });
});
