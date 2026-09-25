import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let managers: ManagerService;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, bus });
});
afterEach(() => server.close());

describe('WS snapshot', () => {
  it('includes managers alongside sessions and approvals', async () => {
    await managers.createManagerSession({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 60, childrenCap: 1, mission: 'x' } } as never);
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    const first = new Promise<string>((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true }));
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const snapshot = JSON.parse(await first);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.managers).toHaveLength(1);
    expect(snapshot.managers[0].missionText).toBe('x');
    ws.close();
  });
});
