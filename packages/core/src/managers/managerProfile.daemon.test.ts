import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;
const api = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...init.headers },
});
const patch = (id: string, body: unknown) => api(`/api/managers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
const profile = async (id: string) => (await (await api(`/api/managers/${id}`)).json()).manager;
async function createManager(): Promise<string> {
  const response = await api('/api/sessions', { method: 'POST', body: JSON.stringify({
    directory: '/tmp', harness: 'fake', name: 'Profile', manager: { mission: 'Ship safely', childrenCap: 4, pulseSeconds: 3600 },
  }) });
  expect(response.status).toBe(201);
  return (await response.json()).id;
}
beforeEach(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-profile-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterEach(async () => { await daemon?.close(); tempDirs.removeAll(); });

describe('the stored manager profile on the real daemon', () => {
  it('publishes the committed profile through WS and get_argus_status', async () => {
    const id = await createManager();
    const { ticket } = await (await api('/api/ws-ticket', { method: 'POST' })).json();
    const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const frames: { type: string; manager?: unknown }[] = [];
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
    const client = new Client({ name: 'profile-test', version: '0.0.0' });
    try {
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'snapshot')).toBe(true));
      const response = await patch(id, { expertise: 'Ship releases', pulseActions: ['Read CI'], expectedProfileRev: 1 });
      expect(response.status).toBe(200);
      const expected = await response.json();
      await vi.waitFor(() => expect(frames).toContainEqual({ type: 'manager.updated', manager: expected }));
      const { mcp_token: token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string };
      await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const result = await client.callTool({ name: 'get_argus_status', arguments: {} });
      const content = result.content as { text: string }[];
      expect(JSON.parse(content[0]!.text).manager).toMatchObject({ expertise: 'Ship releases', pulseActions: ['Read CI'], profileRev: 2 });
    } finally { socket.close(); await client.close(); }
  });

  it.each([
    { expertise: 'x'.repeat(501) },
    { pulseActions: Array.from({ length: 13 }, (_, index) => `Action ${index}`) },
    { pulseActions: ['x'.repeat(281)] },
    { pulseActions: ['same', 'same'] },
    { pulseActions: [' same ', 'same'] },
    { pulseActions: [''] },
    { pulseActions: ['   '] },
    { pulseActions: 'not a list' },
    { expertise: null },
    { expectedProfileRev: 1 },
    { expertise: 'safe', expectedProfileRev: 0 },
  ])('rejects an invalid profile without mutation: %j', async (body) => {
    const id = await createManager();
    const before = await profile(id);

    const response = await patch(id, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(await profile(id)).toEqual(before);
  });

  it('accepts the trimmed limits and explicit empty fields', async () => {
    const id = await createManager();
    const actions = Array.from({ length: 12 }, (_, index) => `${index}`.padEnd(280, 'é'));
    const response = await patch(id, { expertise: ` ${'é'.repeat(500)} `, pulseActions: actions });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ expertise: 'é'.repeat(500), pulseActions: actions, profileRev: 2 });

    expect((await patch(id, { expertise: '  ', pulseActions: [] })).status).toBe(200);
    expect(await profile(id)).toMatchObject({ expertise: '', pulseActions: [], profileRev: 3 });
    await patch(id, { expertise: '', pulseActions: [], expectedProfileRev: 3 });
    expect(await profile(id)).toMatchObject({ profileRev: 3 });
  });

  it('accepts exactly one concurrent author and refuses a stale patch before any field changes', async () => {
    const id = await createManager();
    const responses = await Promise.all([
      patch(id, { expertise: 'first', expectedProfileRev: 1 }),
      patch(id, { expertise: 'second', expectedProfileRev: 1 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const stale = responses.find((response) => response.status === 409)!;
    expect(await stale.json()).toMatchObject({ error: 'stale_revision', detail: { resource: 'manager_profile', currentRev: 2 } });
    const before = await profile(id);

    const refused = await patch(id, { expertise: 'lost', mission: 'lost mission', childrenCap: 8, pulseEnabled: false, model: 'opus', expectedProfileRev: 1 });

    expect(refused.status).toBe(409);
    expect(await profile(id)).toEqual(before);
    await patch(id, { expertise: 'third' });
    await patch(id, { expertise: 'last' });
    expect(await profile(id)).toMatchObject({ expertise: 'last', profileRev: 4 });
  });

  it('revises the whole profile, including changes to its existing fields', async () => {
    const id = await createManager();
    for (const [index, body] of [
      { childrenCap: 5 }, { pulseSeconds: 7200 }, { mission: 'new mission' },
      { pinMissionNote: true }, { pulseEnabled: false }, { model: 'opus' },
    ].entries()) {
      const response = await patch(id, { ...body, expectedProfileRev: index + 1 });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ profileRev: index + 2 });
    }
  });

  it('requires the admin token for profile reads and writes', async () => {
    const id = await createManager();
    const before = await profile(id);
    for (const method of ['GET', 'PATCH']) {
      const response = await fetch(`${daemon.server.url}/api/managers/${id}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ expertise: 'intruder' }) } : {}),
      });
      expect(response.status).toBe(401);
    }
    expect(await profile(id)).toEqual(before);
  });

  it('trims and persists expertise and pulse actions without changing the mission or cadence', async () => {
    const id = await createManager();
    const before = await profile(id);

    const response = await patch(id, { expertise: '  Sécurité 船  ', pulseActions: ['  Vérifier les tests  '] });

    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated).toMatchObject({ expertise: 'Sécurité 船', pulseActions: ['Vérifier les tests'], profileRev: 2 });
    expect(await profile(id)).toEqual({ ...before, expertise: 'Sécurité 船', pulseActions: ['Vérifier les tests'], profileRev: 2 });
    await daemon.close();
    daemon = await startDaemon(config);
    expect(await profile(id)).toMatchObject({ expertise: 'Sécurité 船', pulseActions: ['Vérifier les tests'], profileRev: 2, missionText: 'Ship safely' });
  });
});
