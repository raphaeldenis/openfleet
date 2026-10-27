import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON, MAX_MISSION_DELTA_BYTES } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { loadManagerBase } from './managerBase.js';

const LEGACY_MISSION_BYTES = 30_000;
const SHRUNK_LEGACY_MISSION_BYTES = 20_000;
const GROWN_LEGACY_MISSION_BYTES = 31_000;

const tempDirs = createTempDirTracker();
const openClients: Client[] = [];
let config: Config;
let daemon: Daemon;

const missionOfBytes = (bytes: number) => 'm'.repeat(bytes);
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const createManager = (mission: string, name = `Manager-${Math.random()}`) =>
  api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name, manager: { pulseSeconds: 3600, childrenCap: 5, mission } }) });
const aManagerWithMission = async (mission: string): Promise<string> => ((await (await createManager(mission)).json()) as { id: string }).id;
const aLegacyManager = async (bytes = LEGACY_MISSION_BYTES): Promise<string> => {
  const id = await aManagerWithMission('seed');
  daemon.db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(missionOfBytes(bytes), id);
  return id;
};
const patchMission = (id: string, mission: string) => api(`/api/managers/${id}`, { method: 'PATCH', body: JSON.stringify({ mission }) });
const viewOf = async (id: string) => ((await (await api(`/api/managers/${id}`)).json()) as { manager: { missionText: string; legacyMission: boolean } }).manager;
const errorCodeOf = async (response: Response) => ((await response.json()) as { error: string }).error;
const managerRowCount = () => (daemon.db.prepare('SELECT COUNT(*) AS n FROM managers').get() as { n: number }).n;
const fakeHarness = () => daemon.harnesses.find((harness): harness is FakeHarness => harness instanceof FakeHarness)!;

const mcpClientOf = async (sessionId: string): Promise<Client> => {
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
  const client = new Client({ name: 'mission-delta', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  openClients.push(client);
  return client;
};
const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const spawnManagerThroughMcp = async (parentId: string, mission: string) => {
  const name = `Child-${Math.random()}`;
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  const parent = await mcpClientOf(parentId);
  await parent.callTool({ name: 'get_manager_base', arguments: {} });
  const result = await parent.callTool({ name: 'create_session', arguments: { directory, name, manager: { pulse_seconds: 3600, children_cap: 2, mission } } });
  return { isError: result.isError as boolean | undefined, text: textOf(result) };
};

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-mission-delta-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await daemon.close();
  tempDirs.removeAll();
});

describe('creating a manager with a mission delta', () => {
  it('accepts a mission of exactly 8192 bytes', async () => {
    const response = await createManager(missionOfBytes(MAX_MISSION_DELTA_BYTES));

    expect(response.status).toBe(201);
  });

  it('refuses a mission of 8193 bytes with mission_too_large, and creates nothing', async () => {
    const managersBefore = managerRowCount();
    const sessionsBefore = (daemon.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

    const response = await createManager(missionOfBytes(MAX_MISSION_DELTA_BYTES + 1));

    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('mission_too_large');
    expect(managerRowCount()).toBe(managersBefore);
    expect((daemon.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(sessionsBefore);
  });

  it('counts the bytes of a multi-byte mission: 4096 letters é fit, 4097 do not', async () => {
    expect((await createManager('é'.repeat(4096))).status).toBe(201);
    const refused = await createManager('é'.repeat(4097));
    expect(await errorCodeOf(refused)).toBe('mission_too_large');
  });

  it('counts an emoji as four bytes: 2048 fit, 2049 do not', async () => {
    expect((await createManager('😀'.repeat(2048))).status).toBe(201);
    const refused = await createManager('😀'.repeat(2049));
    expect(await errorCodeOf(refused)).toBe('mission_too_large');
  });

  it('refuses the same mission through the create_session tool of a manager', async () => {
    const parentId = await aManagerWithMission('parent');

    const accepted = await spawnManagerThroughMcp(parentId, missionOfBytes(MAX_MISSION_DELTA_BYTES));
    const refused = await spawnManagerThroughMcp(parentId, missionOfBytes(MAX_MISSION_DELTA_BYTES + 1));

    expect(accepted.isError).toBeUndefined();
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('mission_too_large');
  });
});

describe('editing the mission of a manager', () => {
  it('accepts a patch to exactly 8192 bytes and refuses 8193 with mission_too_large', async () => {
    const id = await aManagerWithMission('small');

    expect((await patchMission(id, missionOfBytes(MAX_MISSION_DELTA_BYTES))).status).toBe(200);
    const refused = await patchMission(id, missionOfBytes(MAX_MISSION_DELTA_BYTES + 1));

    expect(refused.status).toBe(409);
    expect(await errorCodeOf(refused)).toBe('mission_too_large');
    expect((await viewOf(id)).missionText).toBe(missionOfBytes(MAX_MISSION_DELTA_BYTES));
  });

  it('refuses a mission patch above the limit without applying the other fields of the patch', async () => {
    const id = await aManagerWithMission('small');

    const response = await api(`/api/managers/${id}`, { method: 'PATCH', body: JSON.stringify({ childrenCap: 9, mission: missionOfBytes(MAX_MISSION_DELTA_BYTES + 1) }) });

    expect(response.status).toBe(409);
    const profile = (await (await api(`/api/managers/${id}`)).json()) as { manager: { childrenCap: number } };
    expect(profile.manager.childrenCap).toBe(5);
  });

  it('still lets a patch change the cap of a legacy manager without touching its mission', async () => {
    const id = await aLegacyManager();

    const response = await api(`/api/managers/${id}`, { method: 'PATCH', body: JSON.stringify({ childrenCap: 3 }) });

    expect(response.status).toBe(200);
    expect((await viewOf(id)).missionText).toHaveLength(LEGACY_MISSION_BYTES);
  });
});

describe('a legacy manager whose mission is 30 KB', () => {
  it('is still listed in the snapshot of the dashboard', async () => {
    const id = await aLegacyManager();
    const ticket = ((await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string }).ticket;
    const ws = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const firstMessage = new Promise<string>((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true }));

    const snapshot = JSON.parse(await firstMessage) as { managers: { sessionId: string }[] };
    ws.close();

    expect(snapshot.managers.map((manager) => manager.sessionId)).toContain(id);
  });

  it('is still pulsed', async () => {
    const id = await aLegacyManager();

    const response = await api(`/api/managers/${id}/pulse`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pulsed: true });
  });

  it('exposes the legacyMission flag, which a delta-sized manager does not raise', async () => {
    const legacyId = await aLegacyManager();
    const deltaId = await aManagerWithMission(missionOfBytes(MAX_MISSION_DELTA_BYTES));

    expect((await viewOf(legacyId)).legacyMission).toBe(true);
    expect((await viewOf(deltaId)).legacyMission).toBe(false);
  });

  it('can shrink: a patch to 20 KB succeeds, and the flag stays up while it is above 8192 bytes', async () => {
    const id = await aLegacyManager();

    const response = await patchMission(id, missionOfBytes(SHRUNK_LEGACY_MISSION_BYTES));

    expect(response.status).toBe(200);
    expect((await viewOf(id)).legacyMission).toBe(true);
  });

  it('cannot grow: a patch to 31 KB is refused with mission_too_large', async () => {
    const id = await aLegacyManager();

    const response = await patchMission(id, missionOfBytes(GROWN_LEGACY_MISSION_BYTES));

    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('mission_too_large');
    expect((await viewOf(id)).missionText).toHaveLength(LEGACY_MISSION_BYTES);
  });

  it('accepts a patch that keeps the same size', async () => {
    const id = await aLegacyManager();

    expect((await patchMission(id, missionOfBytes(LEGACY_MISSION_BYTES).replace(/^m/, 'n'))).status).toBe(200);
  });

  it('drops the flag once its mission is back at 8192 bytes', async () => {
    const id = await aLegacyManager();

    await patchMission(id, missionOfBytes(MAX_MISSION_DELTA_BYTES));

    expect((await viewOf(id)).legacyMission).toBe(false);
  });
});

describe('the first prompt of a new manager', () => {
  const shippedBase = loadManagerBase();

  const firstPromptOfNewManagerWith = async (mission: string): Promise<string> => {
    const id = await aManagerWithMission(mission);
    const launch = fakeHarness().launches.find((candidate) => candidate.sessionId === id);
    return launch?.seededPrompt ?? '';
  };

  it('is a short primer followed by the mission, which comes last and unchanged', async () => {
    const mission = 'Own the billing project.\nShip the invoices export.';

    const prompt = await firstPromptOfNewManagerWith(mission);

    expect(prompt.endsWith(mission)).toBe(true);
    const primer = prompt.slice(0, prompt.length - mission.length).trim();
    expect(primer.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('tells the manager to read get_manager_base whole, then its mission', async () => {
    const prompt = await firstPromptOfNewManagerWith('Own the billing project.');

    expect(prompt).toMatch(/you are a manager/i);
    expect(prompt).toContain('get_manager_base');
    expect(prompt.indexOf('get_manager_base')).toBeLessThan(prompt.indexOf('Own the billing project.'));
  });

  it('does not copy the manager base into the prompt', async () => {
    const prompt = await firstPromptOfNewManagerWith('Own the billing project.');

    const primerBytes = Buffer.byteLength(prompt, 'utf8') - Buffer.byteLength('Own the billing project.', 'utf8');
    expect(primerBytes).toBeLessThan(shippedBase.bytes / 8);
    for (const section of shippedBase.sections) expect(prompt).not.toContain(section.title);
  });
});
