import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let pulseScheduler: PulseScheduler;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepository = new ManagerRepository(db);
  pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus });
  const managers = new ManagerService({ managers: managerRepository, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json',
  });
});
afterEach(async () => { pulseScheduler.stop(); await server.close(); });

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin' } });
const patchJson = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

async function createManager(): Promise<string> {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 600, childrenCap: 4, mission: 'Ship it' } }),
  });
  return ((await response.json()) as { id: string }).id;
}

const pulseEnabledOf = async (managerId: string) => (await (await api(`/api/managers/${managerId}`)).json()).manager.pulseEnabled;

describe('pausing a manager through the API', () => {
  it('starts enabled, pauses on PATCH pulseEnabled=false and resumes on true', async () => {
    const managerId = await createManager();
    const initiallyEnabled = await pulseEnabledOf(managerId);

    const pauseResponse = await patchJson(`/api/managers/${managerId}`, { pulseEnabled: false });
    const pausedState = await pulseEnabledOf(managerId);
    await patchJson(`/api/managers/${managerId}`, { pulseEnabled: true });
    const resumedState = await pulseEnabledOf(managerId);

    expect(initiallyEnabled).toBe(true);
    expect(pauseResponse.status).toBe(200);
    expect(pausedState).toBe(false);
    expect(resumedState).toBe(true);
  });

  it('refuses a manual pulse for a paused manager with 409 manager_paused', async () => {
    const managerId = await createManager();
    await patchJson(`/api/managers/${managerId}`, { pulseEnabled: false });

    const response = await api(`/api/managers/${managerId}/pulse`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'manager_paused' });
  });

  it('404s an unknown manager', async () => {
    const response = await patchJson('/api/managers/ghost', { pulseEnabled: false });

    expect(response.status).toBe(404);
  });

  it('400s a pulseEnabled that is not a boolean and leaves the manager running', async () => {
    const managerId = await createManager();

    const response = await patchJson(`/api/managers/${managerId}`, { pulseEnabled: 'no' });

    expect(response.status).toBe(400);
    expect(await pulseEnabledOf(managerId)).toBe(true);
  });
});
