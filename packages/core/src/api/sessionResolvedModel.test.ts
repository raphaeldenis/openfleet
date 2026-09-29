import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const migrationsDirectory = new URL('../db/migrations/', import.meta.url);
const migrationsUpTo008 = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '009')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

let server: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(() => server?.close());

const serveDaemonOn = async (db: DatabaseSync) => {
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
};

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server!.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });

const listSessions = async () => (await (await api('/api/sessions')).json()) as Record<string, unknown>[];

describe('session listing with the resolved model fields', () => {
  it('lists a session created before the resolved model migration without the resolved model fields', async () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, migrationsUpTo008);
    db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
      VALUES ('legacy', 'legacy', '/tmp', 'fake', 'closed', 't0', 'h', 'm', 'plan', 'main', 't0')`).run();
    applyMigrations(db);
    await serveDaemonOn(db);

    const [legacySession] = await listSessions();

    expect(legacySession).toMatchObject({ id: 'legacy' });
    expect(legacySession).not.toHaveProperty('resolvedModel');
    expect(legacySession).not.toHaveProperty('cliVersion');
    expect(legacySession).not.toHaveProperty('modelDriftedFrom');
  });

  it('no longer lists the resolved model of a session once its model is switched', async () => {
    const db = openDatabase(':memory:');
    await serveDaemonOn(db);
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    db.prepare(`UPDATE sessions SET resolved_model = 'claude-opus-5-5', cli_version = '2.1.284', model_drifted_from = 'claude-opus-5-4' WHERE id = ?`).run(created.id);
    const [beforeSwitch] = await listSessions();

    await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5' }) });
    const [afterSwitch] = await listSessions();

    expect(beforeSwitch).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: '2.1.284', modelDriftedFrom: 'claude-opus-5-4' });
    expect(afterSwitch).toMatchObject({ model: 'claude-sonnet-5-5', cliVersion: '2.1.284' });
    expect(afterSwitch).not.toHaveProperty('resolvedModel');
    expect(afterSwitch).not.toHaveProperty('modelDriftedFrom');
  });

  it('keeps the resolved model of the other sessions when one session switches its model', async () => {
    const db = openDatabase(':memory:');
    await serveDaemonOn(db);
    const createSession = async (name: string) =>
      (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name, harness: 'fake' }) })).json()) as { id: string };
    const switched = await createSession('switched');
    const untouched = await createSession('untouched');
    for (const { id } of [switched, untouched]) {
      db.prepare(`UPDATE sessions SET resolved_model = 'claude-opus-5-5', cli_version = '2.1.284', model_drifted_from = 'claude-opus-5-4' WHERE id = ?`).run(id);
    }

    await api(`/api/sessions/${switched.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5' }) });
    const listed = await listSessions();
    const switchedAfter = listed.find((session) => session.id === switched.id);
    const untouchedAfter = listed.find((session) => session.id === untouched.id);

    expect(switchedAfter).toMatchObject({ cliVersion: '2.1.284' });
    expect(switchedAfter).not.toHaveProperty('resolvedModel');
    expect(switchedAfter).not.toHaveProperty('modelDriftedFrom');
    expect(untouchedAfter).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: '2.1.284', modelDriftedFrom: 'claude-opus-5-4' });
  });
});
