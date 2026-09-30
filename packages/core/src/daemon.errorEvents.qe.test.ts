import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const socket of openSockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
});

describe('a booted daemon tells its clients why a session failed', () => {
  it('a session whose CLI is not on the PATH closes with a failure reason and broadcasts the matching internal error event', async () => {
    const home = tempDirs.make('of-daemon-error-events-');
    writeFileSync(join(home, 'config.json'), '{}');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0' });
    daemon = await startDaemon(config);
    const { ticket } = (await (await fetch(`${daemon.server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${config.adminToken}` } })).json()) as { ticket: string };
    const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    openSockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('PATH', join(home, 'no-such-bin'));

    await fetch(`${daemon.server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ directory: home, name: 'Boss', harness: 'claude-cli', emoji: '🤖' }),
    });
    for (let attempt = 0; attempt < 300 && !frames.some((frame) => frame.type === 'error'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(frames.filter((frame) => frame.type === 'error' || frame.type === 'session.closed')).toEqual([
      expect.objectContaining({ type: 'session.closed', reason: expect.stringMatching(/^(launch_failed|harness_exit)$/) }),
      expect.objectContaining({ type: 'error', error: expect.objectContaining({ error: expect.stringMatching(/^(launch_failed|harness_exited)$/), kind: 'internal' }) }),
    ]);
  });
});
