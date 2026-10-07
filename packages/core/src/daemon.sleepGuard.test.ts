import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@openfleet/shared';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { FakeClock } from './power/fakeClock.testkit.js';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const sockets: WebSocket[] = [];
let daemon: Daemon | undefined;
let config: Config;
let held = 0;
const clock = new FakeClock();
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon?.db.close();
  daemon = undefined;
});

async function boot(powerSetting?: boolean) {
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, 'daemon-sleep-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ workingState: { enforce: false }, power: powerSetting === undefined ? {} : { preventIdleSleepWhileGenerating: powerSetting } }));
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  held = 0;
  daemon = await startDaemon(config, { power: {
    api: { acquire: () => { held += 1; return { release: () => { held -= 1; } }; } },
    clock: clock.now, schedule: clock.schedule,
  } });
}

async function api(path: string, body?: object): Promise<Response> {
  const response = await fetch(`${daemon!.server.url}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  expect(response.ok).toBe(true);
  return response;
}

async function createChild(): Promise<Session> {
  return (await (await api('/api/sessions', { name: 'worker', directory: config.home, harness: 'fake', emoji: '🤖' })).json()) as Session;
}

async function hook(sessionId: string, hook_event_name: string) {
  const { hookToken } = await (await api(`/api/sessions/${sessionId}/tokens`)).json() as { hookToken: string };
  const response = await fetch(`${daemon!.server.url}/hooks/${hookToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, hook_event_name }) });
  expect(response.ok).toBe(true);
}

async function openClient() {
  const { ticket } = await (await api('/api/ws-ticket', {})).json() as { ticket: string };
  const socket = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  sockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }));
  await waitForFrame(frames, 'snapshot');
  return frames;
}

async function waitForFrame(frames: Record<string, unknown>[], type: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = frames.find((candidate) => candidate.type === type);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`missing ${type}`);
}

describe('booted daemon sleep guard', () => {
  it('publishes the same runtime attention over REST, live WS and reconnect snapshots, and releases at idle', async () => {
    await boot(true);
    const child = await createChild();
    const frames = await openClient();
    await hook(child.id, 'UserPromptSubmit');
    expect(held).toBe(1);

    clock.suspendMs(60_000);
    clock.advanceActiveMs(5000);
    clock.advanceActiveMs(120_000);
    const session = await (await api(`/api/sessions/${child.id}`)).json() as Session;
    expect(session.runtimeAttention).toMatchObject({ reason: 'post_wake_no_progress', wakeSource: 'resume_suspected' });
    const live = await waitForFrame(frames, 'session.attention');
    expect(live).toEqual({ type: 'session.attention', sessionId: child.id, runtimeAttention: session.runtimeAttention });
    const snapshot = await waitForFrame(await openClient(), 'snapshot');
    expect((snapshot.sessions as Session[]).find((candidate) => candidate.id === child.id)?.runtimeAttention).toEqual(session.runtimeAttention);
    expect(held).toBe(1);

    await hook(child.id, 'Stop');
    expect(held).toBe(0);
    expect((await (await api(`/api/sessions/${child.id}`)).json() as Session).runtimeAttention).toBeUndefined();
    await daemon!.close();
    expect(held).toBe(0);
  });

  it('reads the opt out at boot while preserving post-resume health checks', async () => {
    await boot(false);
    const child = await createChild();
    await hook(child.id, 'UserPromptSubmit');
    clock.suspendMs(60_000);
    clock.advanceActiveMs(125_000);
    expect(held).toBe(0);
    expect((await (await api(`/api/sessions/${child.id}`)).json() as Session).runtimeAttention?.reason).toBe('post_wake_no_progress');
  });
});
