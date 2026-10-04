import { homedir } from 'node:os';
import { DIAGNOSTICS_PATH, type DiagnosticsDocument } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHome } from '../config.js';
import { openDatabase } from '../db/database.js';
import { buildDiagnosticsDocument } from '../diagnostics/diagnosticsDocument.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { log } from '../logger.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { createDegradedRegistry, type DegradedRegistry } from '../process/degradedRegistry.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const HOOK_TOKEN = 'hook-token-fedcba9876543210fedcba9876543210';
const MESSAGE_BODY = 'a private message body nobody exports';
const BEARER_FOLLOWED_BY_A_TOKEN = /Bearer\s+(?!\*\*\*)\S+/;

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let degraded: DegradedRegistry;
let listSessionsOverride: (() => ReturnType<SessionService['list']>) | undefined;

async function startDaemonWith(options: { database?: DatabaseSync } = {}): Promise<void> {
  db = options.database ?? openDatabase(':memory:');
  degraded = createDegradedRegistry();
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const diagnostics = () => buildDiagnosticsDocument({ db, degraded, listSessions: listSessionsOverride ?? (() => sessions.list()), port: 7331, e2eEnabled: false });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus, degraded, diagnostics,
  });
}

const fetchDiagnostics = (headers: Record<string, string> = ADMIN) => fetch(`${server.url}${DIAGNOSTICS_PATH}`, { headers });
const documentText = async (): Promise<string> => (await fetchDiagnostics()).text();
const documentOf = async (): Promise<DiagnosticsDocument> => (await fetchDiagnostics()).json() as Promise<DiagnosticsDocument>;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  listSessionsOverride = undefined;
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

describe('GET /api/diagnostics', () => {
  it('is protected by the admin token like the other api routes', async () => {
    await startDaemonWith();

    const withoutToken = await fetchDiagnostics({});
    const withWrongToken = await fetchDiagnostics({ authorization: 'Bearer nope' });

    expect([withoutToken.status, withWrongToken.status]).toEqual([401, 401]);
  });

  it('answers the versions, the sanitized config, the health and the database facts', async () => {
    await startDaemonWith();

    const diagnostics = await documentOf();

    expect(diagnostics.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(diagnostics.version).toEqual({ openfleet: expect.any(String), node: process.version, platform: process.platform });
    expect(diagnostics.config).toEqual({ port: 7331, home: '$OPENFLEET_HOME', e2eEnabled: false });
    expect(diagnostics.health).toEqual({ status: 'ok', issues: [] });
    expect(diagnostics.migrations.length).toBeGreaterThan(0);
    expect(diagnostics.migrations[0]).toEqual({ id: expect.stringMatching(/^001_/), appliedAt: expect.any(String) });
    expect(diagnostics.db.quickCheck).toBe('ok');
    expect(diagnostics.db.sizeBytes).toBeGreaterThan(0);
  });

  it('describes each session without transcript or message body, with the close reason derived from the exit code', async () => {
    await startDaemonWith();
    const created = await sessions.create({ directory: '/tmp', name: 'Builder', emoji: '🤖', harness: 'fake' });
    sessions.sendMessage({ sessionId: created.id, body: MESSAGE_BODY });

    const text = await documentText();
    const { sessions: described } = JSON.parse(text) as DiagnosticsDocument;

    expect(text).not.toContain(MESSAGE_BODY);
    expect(described).toEqual([expect.objectContaining({ id: created.id, name: 'Builder', harness: 'fake', directory: '/tmp', state: expect.any(String) })]);
    expect(Object.keys(described[0]!).sort()).toEqual(expect.arrayContaining(['id', 'name', 'state', 'harness', 'directory']));
    expect(Object.keys(described[0]!)).not.toEqual(expect.arrayContaining(['body', 'messages', 'transcript', 'seededPrompt']));
  });

  it('lists the degraded issues with their refs', async () => {
    await startDaemonWith();
    degraded.mark('db_stuck', 'the database cannot take writes.', { id: 'abcd1234' });

    const { health } = await documentOf();

    expect(health.status).toBe('degraded');
    expect(health.issues).toMatchObject([{ code: 'db_stuck', id: 'abcd1234' }]);
  });

  it('carries the log tail with the ref the UI showed for an error', async () => {
    await startDaemonWith();
    log('error', 'request lost', new Error('boom'), { id: 'beef0001' });

    const { log: tail } = await documentOf();

    expect(tail).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'error', msg: 'request lost', id: 'beef0001' })]));
  });

  // The log ring buffer is process-wide: this test stays above the hostile ones, which write secrets into it.
  it('shows no Bearer and no home path at all on a daemon that logged nothing hostile (the live QA grep, automated)', async () => {
    await startDaemonWith();
    log('info', 'openfleet core listening', undefined, { home: resolveHome() });
    log('error', 'request lost', new Error('boom'), { id: 'beef0004' });
    await sessions.create({ directory: homedir(), name: 'Plain', emoji: '🤖', harness: 'fake' });

    const text = await documentText();

    expect(text.match(/Bearer/g) ?? []).toHaveLength(0);
    expect(text.split(homedir())).toHaveLength(1);
  });
});

describe('the diagnostics document never leaks a secret or a home path (T10)', () => {
  const hostileText = `Bearer ${ADMIN_TOKEN} at http://127.0.0.1:7331/hooks/${HOOK_TOKEN} in ${homedir()}/Documents/Coding/x and ${resolveHome()}/openfleet.db`;

  async function startWithHostileSessionAndLog(): Promise<void> {
    await startDaemonWith();
    const created = await sessions.create({ directory: '/tmp', name: 'Builder', emoji: '🤖', harness: 'fake' });
    db.prepare('UPDATE sessions SET name = ?, directory = ? WHERE id = ?').run(hostileText, `${homedir()}/Documents/Coding/x\nBearer ${ADMIN_TOKEN}`, created.id);
    log('error', hostileText, new Error(hostileText), { id: 'beef0002', token: ADMIN_TOKEN, sessionId: created.id });
    degraded.mark('uncaught_exception', hostileText, { id: 'beef0003', cause: new Error(hostileText) });
  }

  it('contains neither the admin token, nor a hook token, nor a bearer value, nor an absolute home path', async () => {
    await startWithHostileSessionAndLog();

    const text = await documentText();

    expect(text).not.toContain(ADMIN_TOKEN);
    expect(text).not.toContain(HOOK_TOKEN);
    expect(text).not.toMatch(BEARER_FOLLOWED_BY_A_TOKEN);
    expect(text).not.toContain(homedir());
    expect(text).not.toContain(resolveHome());
  });

  it('keeps session directories legible with the user home shortened to ~', async () => {
    await startWithHostileSessionAndLog();

    const { sessions: described } = await documentOf();

    expect(described[0]!.directory).toMatch(/^~\/Documents\/Coding\/x/);
  });

  it('masks a secret hidden under a secret-named key and a secret split by an ansi escape or a NUL', async () => {
    await startDaemonWith();
    log('warn', `Bear\u0000er ${ADMIN_TOKEN}`, undefined, { authorization: `Bearer ${ADMIN_TOKEN}`, note: `\u001b[31m/hooks/${HOOK_TOKEN}\u001b[0m` });

    const text = await documentText();

    expect(text).not.toContain(ADMIN_TOKEN);
    expect(text).not.toContain(HOOK_TOKEN);
  });
});

describe('hostile 8: the document while the database is stuck', () => {
  const stuckMessage = `unable to open database file: ${homedir()}/.openfleet/openfleet.db (Bearer ${ADMIN_TOKEN})`;

  function stuckDatabase(): DatabaseSync {
    const real = openDatabase(':memory:');
    let isStuck = false;
    return new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'prepare') return (sql: string) => { if (isStuck) throw Object.assign(new Error(stuckMessage), { errcode: 14 }); return target.prepare(sql); };
        if (property === 'exec') return (sql: string) => target.exec(sql);
        if (property === 'stickForTest') return () => { isStuck = true; };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('still answers 200 with db_stuck in health.issues and the redacted error text as the quick check', async () => {
    const database = stuckDatabase();
    await startDaemonWith({ database });
    listSessionsOverride = () => { throw Object.assign(new Error(stuckMessage), { errcode: 14 }); };
    degraded.mark('db_stuck', 'the database cannot take writes.', { id: 'dead0001' });
    (database as unknown as { stickForTest: () => void }).stickForTest();

    const response = await fetchDiagnostics();
    const text = await response.clone().text();
    const diagnostics = await response.json() as DiagnosticsDocument;

    expect(response.status).toBe(200);
    expect(diagnostics.health.issues).toMatchObject([{ code: 'db_stuck', id: 'dead0001' }]);
    expect(diagnostics.db.quickCheck).toContain('unable to open database file');
    expect(diagnostics.db.quickCheck).not.toBe('ok');
    expect(diagnostics.sessions).toEqual([]);
    expect(diagnostics.migrations).toEqual([]);
    expect(text).not.toContain(ADMIN_TOKEN);
    expect(text).not.toContain(homedir());
  });
});
