import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';
const AUTHORIZED = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

let server: Awaited<ReturnType<typeof startServer>>;
let homeDirectory: string;
let configPath: string;

beforeEach(async () => {
  homeDirectory = mkdtempSync(join(tmpdir(), 'of-models-'));
  configPath = join(homeDirectory, 'config.json');
  server = await startServerWithConfigAt(configPath);
});

afterEach(async () => {
  await server.close();
  rmSync(homeDirectory, { recursive: true, force: true });
});

async function startServerWithConfigAt(modelConfigPath: string) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  return startServer({ host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus, modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath });
}

const putModels = (body: unknown, headers: Record<string, string> = AUTHORIZED) =>
  fetch(`${server.url}/api/models`, { method: 'PUT', headers, body: JSON.stringify(body) });
const getModels = () => fetch(`${server.url}/api/models`, { headers: AUTHORIZED });
const getAvailableModels = (headers: Record<string, string> = AUTHORIZED) => fetch(`${server.url}/api/models/available`, { headers });
const createSession = (model: string) =>
  fetch(`${server.url}/api/sessions`, { method: 'POST', headers: AUTHORIZED, body: JSON.stringify({ directory: '/tmp', name: 'S', harness: 'fake', model }) });
const readConfigFile = () => JSON.parse(readFileSync(configPath, 'utf8')) as unknown;

describe('PUT /api/models', () => {
  it('answers with the whole table, the saved rung changed and the other three untouched', async () => {
    const res = await putModels({ opus: 'claude-opus-5-5-preview' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { models: unknown }).models).toEqual({ ...DEFAULT_MODEL_TABLE, opus: 'claude-opus-5-5-preview' });
  });

  it('serves the new id from GET /api/models straight away, with no restart', async () => {
    await putModels({ sonnet: 'claude-sonnet-5-b' });

    expect(await (await getModels()).json()).toEqual({ ...DEFAULT_MODEL_TABLE, sonnet: 'claude-sonnet-5-b' });
  });

  it('launches the next session of that rung on the new id', async () => {
    await putModels({ sonnet: 'claude-sonnet-5-b' });

    const created = (await (await createSession('sonnet')).json()) as { model: string };

    expect(created.model).toBe('claude-sonnet-5-b');
  });

  it('leaves a session that is already running on the id it launched with', async () => {
    const running = (await (await createSession('sonnet')).json()) as { id: string; model: string };

    const saved = await putModels({ sonnet: 'claude-sonnet-5-b' });

    expect(saved.status).toBe(200);
    const sessions = (await (await fetch(`${server.url}/api/sessions`, { headers: AUTHORIZED })).json()) as Array<{ id: string; model: string }>;
    expect(sessions.find((session) => session.id === running.id)?.model).toBe(DEFAULT_MODEL_TABLE.sonnet);
  });

  it('writes the choice to config.json on disk', async () => {
    await putModels({ opus: 'claude-opus-5-5-preview' });

    expect(readConfigFile()).toEqual({ models: { opus: 'claude-opus-5-5-preview' } });
  });

  it('keeps earlier rungs and unrelated keys already in config.json', async () => {
    writeFileSync(configPath, JSON.stringify({ theme: 'dark', models: { haiku: 'my-haiku', opus: 'old-opus' } }));

    await putModels({ opus: 'claude-opus-5-5-preview' });

    expect(readConfigFile()).toEqual({ theme: 'dark', models: { haiku: 'my-haiku', opus: 'claude-opus-5-5-preview' } });
  });

  it('saves the id trimmed', async () => {
    await putModels({ opus: '  claude-opus-5-5-preview  ' });

    expect((await (await getModels()).json() as Record<string, string>).opus).toBe('claude-opus-5-5-preview');
    expect(readConfigFile()).toEqual({ models: { opus: 'claude-opus-5-5-preview' } });
  });

  it.each([
    ['an empty patch', {}],
    ['an empty id', { opus: '' }],
    ['a blank id', { opus: '   ' }],
    ['a non-string id', { opus: 5 }],
    ['an id with a space inside', { opus: 'claude opus' }],
    ['an id with a shell metacharacter', { opus: 'claude-opus;rm' }],
    ['an id longer than 100 characters', { opus: 'a'.repeat(101) }],
    ['a body that is not an object', ['claude-opus-5-5']],
  ])('refuses %s with a 400 and changes nothing', async (_label, body) => {
    const res = await putModels(body);

    expect(res.status).toBe(400);
    expect(await (await getModels()).json()).toEqual(DEFAULT_MODEL_TABLE);
    expect(readdirSync(homeDirectory)).toEqual([]);
  });

  it('refuses with a 409 and leaves a config.json it cannot parse untouched', async () => {
    writeFileSync(configPath, '{ this is not json');

    const res = await putModels({ opus: 'claude-opus-5-5-preview' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'config_unreadable' });
    expect(readFileSync(configPath, 'utf8')).toBe('{ this is not json');
    expect(await (await getModels()).json()).toEqual(DEFAULT_MODEL_TABLE);
  });

  it('refuses with a 409 when config.json holds a model table that is not an object', async () => {
    writeFileSync(configPath, JSON.stringify({ models: 'nope' }));

    const res = await putModels({ opus: 'claude-opus-5-5-preview' });

    expect(res.status).toBe(409);
    expect(readConfigFile()).toEqual({ models: 'nope' });
  });

  it('refuses a request without the admin token and changes nothing', async () => {
    const res = await putModels({ opus: 'claude-opus-5-5-preview' }, { 'content-type': 'application/json' });

    expect(res.status).toBe(401);
    expect(await (await getModels()).json()).toEqual(DEFAULT_MODEL_TABLE);
    expect(readdirSync(homeDirectory)).toEqual([]);
  });

  it('is allowed by the CORS preflight of the desktop app origin', async () => {
    const res = await fetch(`${server.url}/api/models`, { method: 'OPTIONS', headers: { origin: 'http://localhost:1420', 'access-control-request-method': 'PUT' } });

    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
  });
});

describe('GET /api/models/available', () => {
  it('lists every id of the default table', async () => {
    const res = await getAvailableModels();

    expect(res.status).toBe(200);
    const { models } = (await res.json()) as { models: string[] };
    expect(models).toEqual(expect.arrayContaining(Object.values(DEFAULT_MODEL_TABLE)));
  });

  it('lists each id once', async () => {
    const { models } = (await (await getAvailableModels()).json()) as { models: string[] };

    expect(new Set(models).size).toBe(models.length);
  });

  it('offers Opus 5.5 with 1M context, and a rung accepts and saves that id', async () => {
    const opusWithOneMillionContext = 'claude-opus-5-5[1m]';

    const { models } = (await (await getAvailableModels()).json()) as { models: string[] };
    const saved = await putModels({ opus: opusWithOneMillionContext });

    expect(models).toContain(opusWithOneMillionContext);
    expect(saved.status).toBe(200);
    expect(readConfigFile()).toEqual({ models: { opus: opusWithOneMillionContext } });
  });

  it('requires the admin token', async () => {
    const res = await getAvailableModels({});

    expect(res.status).toBe(401);
  });
});
