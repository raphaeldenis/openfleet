import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE, type ModelTable } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';
const RUNGS = ['fable', 'haiku', 'opus', 'sonnet'];

const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function startServerServing(modelTable: ModelTable) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json' });
  openServers.push(server);
  return server;
}

async function getModels(server: { url: string }, init: RequestInit = {}, query = '') {
  return fetch(`${server.url}/api/models${query}`, init);
}

describe('GET /api/models authentication', () => {
  it('refuses the admin token smuggled in the ?token query parameter', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, {}, `?token=${ADMIN_TOKEN}`);

    expect(res.status).toBe(401);
  });

  it.each([
    ['a lowercase scheme', 'bearer admin'],
    ['a token differing only by case', 'Bearer ADMIN'],
    ['the token followed by extra characters', 'Bearer admin-extra'],
    ['a doubled separator', 'Bearer  admin'],
  ])('refuses %s in the authorization header', async (_label, authorization) => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, { headers: { authorization } });

    expect(res.status).toBe(401);
  });

  it('accepts the admin token when the request also carries an unrelated query string', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, '?refresh=1');

    expect(res.status).toBe(200);
  });

  it('does not let a POST with a valid token write to the model table', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ opus: 'hijacked' }) });

    expect(res.status).toBe(404);
    const followUp = await getModels(server, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(await followUp.json()).toEqual(DEFAULT_MODEL_TABLE);
  });
});

describe('GET /api/models response shape', () => {
  const authorized = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };

  it('answers with a JSON content type and exactly the four rungs', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, authorized);

    expect(res.headers.get('content-type')).toContain('application/json');
    expect(Object.keys((await res.json()) as object).sort()).toEqual(RUNGS);
  });

  it('serves an overridden rung and keeps the other three at their defaults', async () => {
    const server = await startServerServing({ ...DEFAULT_MODEL_TABLE, opus: 'my-private-opus' });

    const body = await (await getModels(server, authorized)).json();

    expect(body).toEqual({ ...DEFAULT_MODEL_TABLE, opus: 'my-private-opus' });
  });

  it('projects the response onto the four rungs even when the served table carries extra keys', async () => {
    const tableWithExtraKey = { ...DEFAULT_MODEL_TABLE, apiKey: 'sk-should-never-leave-the-daemon' } as unknown as ModelTable;
    const server = await startServerServing(tableWithExtraKey);

    const bodyText = await (await getModels(server, authorized)).text();

    expect(bodyText).not.toContain('sk-should-never-leave-the-daemon');
  });
});
