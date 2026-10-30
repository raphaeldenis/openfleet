import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import type { FakeHarness } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const START_SIGNAL_TIMEOUT_MS = 400;
const tempDirs = createTempDirTracker();
let config: Config;
let daemon: Daemon;
let manager: Client;
let managerId: string;
let spawnedChildCount = 0;
const frames: { type: string; sessionId?: string; reason?: string }[] = [];

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });

const spawnChild = async () => {
  spawnedChildCount += 1;
  const name = `silent-child-${spawnedChildCount}`;
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  const result = await manager.callTool({ name: 'create_session', arguments: { directory, name } });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text, id: result.isError ? '' : (JSON.parse(text) as { id: string }).id };
};

const waitUntil = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-start-signal-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config, {});
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name: 'Capped', manager: { pulseSeconds: 3600, childrenCap: 1, mission: 'Ship the fleet' } }) });
  managerId = ((await created.json()) as { id: string }).id;
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(managerId) as { mcp_token: string };
  manager = new Client({ name: 'start-signal', version: '0.0.0' });
  await manager.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  await manager.callTool({ name: 'get_manager_base', arguments: {} });
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const fakeHarness = daemon.harnesses.find((harness) => harness.id === 'fake') as { startSignalTimeoutMs?: number } & FakeHarness;
  fakeHarness.startSignalTimeoutMs = START_SIGNAL_TIMEOUT_MS;
});
afterAll(async () => {
  await manager.close();
  await daemon.close();
  tempDirs.removeAll();
});

describe('a child whose harness never signals its start', () => {
  it('fails within the delay, is announced on the WebSocket, and frees the cap for the next create_session', async () => {
    const silentChild = await spawnChild();
    const refusedWhileLive = await spawnChild();

    await waitUntil(() => frames.some((frame) => frame.type === 'session.failed' && frame.sessionId === silentChild.id));
    const afterFailure = await spawnChild();

    expect(silentChild.isError).toBe(false);
    expect(refusedWhileLive.text).toContain('children_cap');
    expect(frames).toContainEqual(expect.objectContaining({ type: 'session.failed', sessionId: silentChild.id, reason: 'no_start_signal' }));
    expect(afterFailure.isError).toBe(false);
    const failedSession = (await (await api(`/api/sessions/${silentChild.id}`)).json()) as { readiness: string; readinessReason: string };
    expect(failedSession).toMatchObject({ readiness: 'failed', readinessReason: 'no_start_signal' });
  });
});
