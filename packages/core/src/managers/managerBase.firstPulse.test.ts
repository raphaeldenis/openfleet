import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { loadManagerBase } from './managerBase.js';

const tempDirs = createTempDirTracker();
const shippedBase = loadManagerBase();

let config: Config;
let daemon: Daemon;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const aNewManager = async (name: string) =>
  ((await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name, manager: { pulseSeconds: 3600, childrenCap: 5, mission: 'Ship the fleet' } }) })).json()) as { id: string }).id;
const pulseBodiesOf = (managerId: string) =>
  (daemon.db.prepare('SELECT body FROM message_queue WHERE session_id = ? AND body LIKE ?').all(managerId, '[pulse]%') as { body: string }[]).map((row) => row.body);
const managerViewOf = async (managerId: string) =>
  ((await (await api(`/api/managers/${managerId}`)).json()) as { manager: { baseRead?: unknown; deniedCommandCount: number; noteNotReadWarningCount: number } }).manager;

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-base-first-pulse-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterAll(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('the first pulse of a new manager that has not read the base yet', () => {
  it('is delivered with the base version and sha, without a refusal', async () => {
    const managerId = await aNewManager('Newcomer');

    const pulse = await api(`/api/managers/${managerId}/pulse`, { method: 'POST' });

    expect(pulse.ok).toBe(true);
    const [pulseBody] = pulseBodiesOf(managerId);
    expect(pulseBody).toContain(`Base v${shippedBase.version} (${shippedBase.sha.slice(0, 8)}).`);
  });

  it('leaves no incident behind: no denied command, no note warning, the base shown as not read', async () => {
    const managerId = await aNewManager('Quiet');

    await api(`/api/managers/${managerId}/pulse`, { method: 'POST' });

    const manager = await managerViewOf(managerId);
    expect(manager.baseRead).toBeUndefined();
    expect(manager.deniedCommandCount).toBe(0);
    expect(manager.noteNotReadWarningCount).toBe(0);
  });
});
