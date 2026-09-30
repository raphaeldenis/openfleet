import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';

let daemon: Daemon | undefined;
let adminToken: string;

async function bootDaemon(configJson?: object): Promise<Daemon> {
  const home = mkdtempSync(join(tmpdir(), 'of-daemon-wiring-'));
  if (configJson) writeFileSync(join(home, 'config.json'), JSON.stringify(configJson));
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0' });
  adminToken = config.adminToken;
  daemon = await startDaemon(config);
  return daemon;
}
afterEach(async () => { await daemon?.close(); daemon = undefined; });

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (extra: Record<string, unknown> = {}) => (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const postHook = async (sessionId: string, body: Record<string, unknown>) => {
  const response = await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<{ decision?: string; hookSpecificOutput?: { additionalContext: string } }>;
};

async function firstWsFrame(): Promise<{ workingStateMaxAgeMinutes?: number; managers: { pulseSeconds: number }[] }> {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  const frame = await new Promise<string>((resolve) => ws.addEventListener('message', (message) => resolve(String(message.data)), { once: true }));
  ws.close();
  return JSON.parse(frame);
}

describe('operator gets every daemon feature when the daemon boots from its config', () => {
  it('refuses the end of a turn that has no working state', async () => {
    await bootDaemon();
    const session = await createSession();
    await postHook(session.id, { hook_event_name: 'UserPromptSubmit' });

    const answer = await postHook(session.id, { hook_event_name: 'Stop' });

    expect(answer.decision).toBe('block');
  });

  it('gives a cleared session its working state back as additional context', async () => {
    await bootDaemon();
    const session = await createSession();

    const answer = await postHook(session.id, { hook_event_name: 'SessionStart', source: 'clear' });

    expect(answer.hookSpecificOutput?.additionalContext).toBeTruthy();
  });

  it('serves the working-state route (a session without state answers no_state, not a missing route)', async () => {
    await bootDaemon();
    const session = await createSession();

    const response = await api(`/api/sessions/${session.id}/working-state`);

    expect((await response.json())).toEqual({ error: 'no_state' });
  });

  it('tells connected clients the working-state max age configured in config.json', async () => {
    await bootDaemon({ workingState: { maxAgeMinutes: 45 } });

    const snapshot = await firstWsFrame();

    expect(snapshot.workingStateMaxAgeMinutes).toBe(45);
  });

  it('gives a manager created without a pulse the configured default heartbeat', async () => {
    await bootDaemon({ managers: { heartbeatDefaultSeconds: 777 } });

    await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });
    const snapshot = await firstWsFrame();

    expect(snapshot.managers[0]?.pulseSeconds).toBe(777);
  });
});
