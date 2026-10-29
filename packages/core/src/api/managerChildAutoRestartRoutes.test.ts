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

const childAutoRestartOf = async (managerId: string) => (await (await api(`/api/managers/${managerId}`)).json()).manager.childAutoRestart;

describe('the automatic restart of the children of a manager through the API', () => {
  it('is off for a new manager', async () => {
    const managerId = await createManager();

    expect(await childAutoRestartOf(managerId)).toBe(false);
  });

  it('turns on with PATCH childAutoRestart=true and off again with false', async () => {
    const managerId = await createManager();

    const enableResponse = await patchJson(`/api/managers/${managerId}`, { childAutoRestart: true });
    const enabledState = await childAutoRestartOf(managerId);
    await patchJson(`/api/managers/${managerId}`, { childAutoRestart: false });
    const disabledState = await childAutoRestartOf(managerId);

    expect(enableResponse.status).toBe(200);
    expect(enabledState).toBe(true);
    expect(disabledState).toBe(false);
  });

  it('refuses a value that is not a boolean with 400 and keeps the stored option', async () => {
    const managerId = await createManager();

    const response = await patchJson(`/api/managers/${managerId}`, { childAutoRestart: 'yes' });

    expect(response.status).toBe(400);
    expect(await childAutoRestartOf(managerId)).toBe(false);
  });
});
