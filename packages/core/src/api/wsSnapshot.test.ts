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
let pulseScheduler: PulseScheduler;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
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

  it('starts with an empty managers array when none exist, rather than omitting the field', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    const first = new Promise<string>((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true }));
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const snapshot = JSON.parse(await first);
    expect(snapshot.managers).toEqual([]);
    ws.close();
  });
});

// A connected client sees every broadcast on the bus, not just the manager ones — createManagerSession
// itself broadcasts session.created before manager.created, and a pulse on a non-idle session broadcasts
// message.queued before manager.pulsed. Collect messages and find the one under test rather than assuming
// it is the very next frame.
function collectMessages(ws: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    ws.addEventListener('message', function onMessage(m) {
      events.push(JSON.parse(String(m.data)));
      if (events.length === count) {
        ws.removeEventListener('message', onMessage);
        resolve(events);
      }
    });
  });
}

describe('WS live broadcasts', () => {
  it('streams manager.created to already-connected clients when a manager session is made', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    await new Promise((r) => ws.addEventListener('message', r, { once: true })); // consume the initial snapshot

    const nextMessages = collectMessages(ws, 2); // session.created, then manager.created
    const created = await managers.createManagerSession({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 60, childrenCap: 1, mission: 'ship it' } } as never);
    const events = await nextMessages;

    expect(events).toContainEqual({ type: 'manager.created', manager: expect.objectContaining({ sessionId: created.id, missionText: 'ship it', childrenCount: 0 }) });
    ws.close();
  });

  it('streams manager.pulsed to already-connected clients when a manager is pulsed on demand', async () => {
    const created = await managers.createManagerSession({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 60, childrenCap: 1, mission: 'x' } } as never);
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    await new Promise((r) => ws.addEventListener('message', r, { once: true })); // consume the initial snapshot

    // The session never received SessionStart, so it is still 'starting' — the pulse itself only queues
    // (message.queued), broadcast right before manager.pulsed.
    const nextMessages = collectMessages(ws, 2);
    pulseScheduler.pulseNow(created.id);
    const events = await nextMessages;

    expect(events).toContainEqual({ type: 'manager.pulsed', manager: expect.objectContaining({ sessionId: created.id, lastPulseAt: expect.any(String) }) });
    ws.close();
  });
});
