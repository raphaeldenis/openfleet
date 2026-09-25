import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from './managerRepository.js';
import { PulseScheduler, PULSE_MESSAGE } from './pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';

function setup() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ managers, sessions, bus });
  return { db, bus, harness, sessions, managers, scheduler };
}
const hook = (session_id: string, event: object) => ({ kind: 'hook' as const, event: { session_id, ...event } as never });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PulseScheduler', () => {
  it('delivers the pulse message immediately when the manager is idle', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });

    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(1000);

    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);
  });

  it('queues the pulse instead of delivering it while the manager is waiting_permission', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });

    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(1000);

    expect(harness.handles[0]!.written).toEqual([]);

    sessions.applyInput(manager.id, { kind: 'permission_resolved' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);
  });

  it('reschedules the next pulse pulseSeconds after the one it just sent', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });

    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(1000);
    expect(harness.handles[0]!.written).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(harness.handles[0]!.written).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.handles[0]!.written).toHaveLength(2);
  });

  it('never reschedules a manager whose session has closed', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    harness.handles[0]!.emitExit(0);

    vi.advanceTimersByTime(1000);

    expect(harness.handles[0]!.written).toEqual([]);
  });

  it('pulseNow fires immediately and re-arms the timer from that moment', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1000, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    const record = scheduler.pulseNow(manager.id);

    expect(record).toBeDefined();
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);
  });

  it('start() re-arms every persisted manager, honoring elapsed time since its last pulse', async () => {
    const { db, bus } = setup();
    const harness = new FakeHarness();
    const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const managers = new ManagerRepository(db);
    const almostDue = new Date(Date.now() - 900 * 1000).toISOString(); // pulsed 900s ago, pulseSeconds=1000 → 100s left
    managers.insert({ sessionId: manager.id, pulseSeconds: 1000, childrenCap: 1, missionText: 'x', lastPulseAt: almostDue, createdAt: almostDue });

    const scheduler = new PulseScheduler({ managers, sessions, bus });
    scheduler.start();

    vi.advanceTimersByTime(99_000);
    expect(harness.handles[0]!.written).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);
  });
});
