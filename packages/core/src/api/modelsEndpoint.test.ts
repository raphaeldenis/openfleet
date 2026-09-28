import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE, loadModelTable, type ModelTable } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';
const RUNGS = ['fable', 'haiku', 'opus', 'sonnet'];

const openServers: Array<{ close(): Promise<void> }> = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  scratchDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function startServerServing(modelTable: ModelTable) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus, modelTable });
  openServers.push(server);
  return server;
}

function modelTableFromConfigFile(configContents: string): ModelTable {
  const home = mkdtempSync(join(tmpdir(), 'of-models-endpoint-'));
  scratchDirs.push(home);
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, configContents);
  return loadModelTable(configPath);
}

async function getModels(server: { url: string }, init: RequestInit = {}, query = '') {
  return fetch(`${server.url}/api/models${query}`, init);
}

describe('GET /api/models authentication', () => {
  it('refuses a wrong bearer token and reveals no model id in the refusal', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, { headers: { authorization: 'Bearer not-the-admin-token' } });

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('claude-');
  });

  it('refuses a request with no authorization header', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server);

    expect(res.status).toBe(401);
  });

  it.each([
    ['token', 'token'],
    ['access_token', 'access_token'],
    ['authorization', 'authorization'],
  ])('refuses the admin token smuggled in the ?%s query parameter', async (_label, parameterName) => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, {}, `?${parameterName}=${ADMIN_TOKEN}`);

    expect(res.status).toBe(401);
  });

  it('refuses a wrong bearer token even when the right token also rides in the query string', async () => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, { headers: { authorization: 'Bearer wrong' } }, `?token=${ADMIN_TOKEN}`);

    expect(res.status).toBe(401);
  });

  it.each([
    ['a lowercase scheme', 'bearer admin'],
    ['a different scheme', 'Basic admin'],
    ['a bare scheme with no token', 'Bearer'],
    ['a token differing only by case', 'Bearer ADMIN'],
    ['the token without a scheme', 'admin'],
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

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('does not let a %s with a valid token write to or read the model table', async (method) => {
    const server = await startServerServing(DEFAULT_MODEL_TABLE);

    const res = await getModels(server, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ opus: 'hijacked' }) });

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

  it('serves a rung overridden in config.json and keeps the other three at their defaults', async () => {
    const overriddenTable = modelTableFromConfigFile(JSON.stringify({ models: { opus: 'my-private-opus' } }));
    const server = await startServerServing(overriddenTable);

    const body = await (await getModels(server, authorized)).json();

    expect(body).toEqual({ ...DEFAULT_MODEL_TABLE, opus: 'my-private-opus' });
  });

  it('serves the defaults when config.json holds no models key at all', async () => {
    const server = await startServerServing(modelTableFromConfigFile(JSON.stringify({ somethingElse: true })));

    const body = await (await getModels(server, authorized)).json();

    expect(body).toEqual(DEFAULT_MODEL_TABLE);
  });

  it('leaks nothing from unknown keys in config.json, at the top level or inside models', async () => {
    const hostileConfig =
      '{"apiKey":"sk-top-level-secret","models":{"opus":"my-opus","gpt":"gpt-4","secret":"inside-models-secret","__proto__":{"polluted":"proto-secret"},"constructor":"ctor-secret"}}';
    const server = await startServerServing(modelTableFromConfigFile(hostileConfig));

    const res = await getModels(server, authorized);
    const bodyText = await res.text();

    expect(Object.keys(JSON.parse(bodyText) as object).sort()).toEqual(RUNGS);
    expect(bodyText).not.toMatch(/secret|gpt-4|polluted/);
    expect(bodyText).toContain('my-opus');
  });

  it('keeps unrelated Object.prototype state clean after loading a config with a __proto__ key', async () => {
    modelTableFromConfigFile('{"models":{"__proto__":{"polluted":"yes"}}}');

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('projects the response onto the four rungs even when the served table carries extra keys', async () => {
    const tableWithExtraKey = { ...DEFAULT_MODEL_TABLE, apiKey: 'sk-should-never-leave-the-daemon' } as unknown as ModelTable;
    const server = await startServerServing(tableWithExtraKey);

    const bodyText = await (await getModels(server, authorized)).text();

    expect(bodyText).not.toContain('sk-should-never-leave-the-daemon');
  });

  it('refuses a config.json that blanks a rung instead of serving an empty model id', () => {
    const blankRungConfig = JSON.stringify({ models: { sonnet: '' } });

    expect(() => modelTableFromConfigFile(blankRungConfig)).toThrow();
  });
});
