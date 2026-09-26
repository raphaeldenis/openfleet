import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from './managerRepository.js';
import { toManagerView } from './managerView.js';
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
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    const record = scheduler.pulseNow(manager.id);

    expect(record).toBeDefined();
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);

    // The re-arm is anchored to the manual pulse's own moment, not the original schedule: the next
    // pulse lands a full pulseSeconds after pulseNow, not after whatever the original cadence expected.
    vi.advanceTimersByTime(999);
    expect(harness.handles[0]!.written).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`, `${PULSE_MESSAGE}\r`]);
  });

  it('restarting the scheduler on the same db resumes cadence from the persisted lastPulseAt', async () => {
    const { db, bus } = setup();
    const harness = new FakeHarness();
    let sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const managers = new ManagerRepository(db);
    managers.insert({ sessionId: manager.id, pulseSeconds: 100, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });

    let scheduler = new PulseScheduler({ managers, sessions, bus });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(100_000); // a real pulse, persisting lastPulseAt for real this time
    expect(harness.handles[0]!.written).toHaveLength(1);

    // Simulate a daemon restart: tear down this scheduler and rebuild SessionService on the same db —
    // resumeAll() is what a real restart does to reattach a harness handle to every open session.
    scheduler.stop();
    sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await sessions.resumeAll();
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    scheduler = new PulseScheduler({ managers, sessions, bus });

    scheduler.start();

    vi.advanceTimersByTime(99_000);
    expect(harness.handles[1]!.written).toEqual([]); // not yet due again
    vi.advanceTimersByTime(1_000);
    expect(harness.handles[1]!.written).toEqual([`${PULSE_MESSAGE}\r`]); // cadence resumed from the persisted lastPulseAt
  });
});

describe('PulseScheduler — hostile cases', () => {
  it('pulseNow returns undefined for an id with no manager record at all', () => {
    const { scheduler } = setup();
    expect(scheduler.pulseNow('no-such-session')).toBeUndefined();
  });

  it('pulseNow returns undefined for a real, non-manager session', async () => {
    const { scheduler, sessions } = setup();
    const plainChild = await sessions.create({ directory: '/tmp', name: 'Gimli', emoji: '⚔️', harness: 'fake' });
    expect(scheduler.pulseNow(plainChild.id)).toBeUndefined();
  });

  it('pulseNow on a manager whose session already closed writes nothing, broadcasts nothing, and arms no timer', async () => {
    const { scheduler, sessions, managers, harness, bus } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1000, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    harness.handles[0]!.emitExit(0);
    expect(sessions.get(manager.id)!.state).toBe('closed');

    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));

    // A closed manager is never pulsed: pulseNow shares the same aliveness check tick() uses, so a
    // manual pulse on a dead session is a no-op rather than a misleading record/broadcast.
    const record = scheduler.pulseNow(manager.id);

    expect(record).toBeUndefined();
    expect(managers.get(manager.id)!.lastPulseAt).toBeUndefined();
    expect(events).toEqual([]);
    expect(harness.handles[0]!.written).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // no timer got armed by the no-op pulseNow
  });

  it('a manual pulseNow right after the timer already pulsed, while still idle, delivers a second pulse rather than being deduplicated', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(1000);
    expect(harness.handles[0]!.written).toHaveLength(1); // the timer's own pulse

    scheduler.pulseNow(manager.id);

    // The manager is still idle (nothing consumed the first pulse's turn), so the manual pulse is
    // delivered immediately too — two [pulse] messages land back to back for what a human would read
    // as "one" due pulse. Pin this so a debounce, if one gets added, changes this expectation on purpose.
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`, `${PULSE_MESSAGE}\r`]);
  });

  it('emits manager.pulsed with the updated lastPulseAt and current childrenCount, not the record from before the pulse', async () => {
    const { scheduler, sessions, managers, harness, bus } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 5, missionText: 'ship it', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    await sessions.create({ directory: '/tmp', name: 'Gimli', emoji: '⚔️', harness: 'fake', parentId: manager.id });

    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));
    vi.advanceTimersByTime(1000);

    expect(harness.handles[0]!.written).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'manager.pulsed',
      manager: expect.objectContaining({ sessionId: manager.id, missionText: 'ship it', childrenCount: 1, lastPulseAt: expect.any(String) }),
    });
  });

  it('stop() cancels every armed timer so no manager pulses again', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    scheduler.stop();
    vi.advanceTimersByTime(60_000);

    expect(harness.handles[0]!.written).toEqual([]);
  });

  it('calling start() twice does not double-fire a manager due at boot', async () => {
    const { db, bus } = setup();
    const harness = new FakeHarness();
    const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const managers = new ManagerRepository(db);
    const alreadyDue = new Date(Date.now() - 2000).toISOString();
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', lastPulseAt: alreadyDue, createdAt: alreadyDue });
    const scheduler = new PulseScheduler({ managers, sessions, bus });

    scheduler.start();
    scheduler.start();
    vi.advanceTimersByTime(0);

    expect(harness.handles[0]!.written).toHaveLength(1);
  });

  it('a manager already overdue at boot pulses on the very next tick instead of waiting a full pulseSeconds', async () => {
    const { db, bus } = setup();
    const harness = new FakeHarness();
    const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const managers = new ManagerRepository(db);
    const wayOverdue = new Date(Date.now() - 5_000_000).toISOString();
    managers.insert({ sessionId: manager.id, pulseSeconds: 1000, childrenCap: 1, missionText: 'x', lastPulseAt: wayOverdue, createdAt: wayOverdue });
    const scheduler = new PulseScheduler({ managers, sessions, bus });

    scheduler.start();
    vi.advanceTimersByTime(0);

    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);
  });

  it('a manager record with lastPulseAt in the future (clock skew) waits the full remaining delay instead of firing immediately', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const inTheFuture = new Date(Date.now() + 10_000).toISOString();
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', lastPulseAt: inTheFuture, createdAt: new Date().toISOString() });

    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(10_999);
    expect(harness.handles[0]!.written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(harness.handles[0]!.written).toEqual([`${PULSE_MESSAGE}\r`]);
  });

  it('coalesces repeated cadence ticks and manual pulses into a single queued pulse while the manager is gated', async () => {
    const { scheduler, sessions, managers, db } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    vi.advanceTimersByTime(3000); // 3 cadences while waiting_permission
    scheduler.pulseNow(manager.id);
    scheduler.pulseNow(manager.id);

    const queuedCount = (db.prepare(`SELECT COUNT(*) as c FROM message_queue WHERE session_id = ? AND status = 'queued'`).get(manager.id) as { c: number }).c;
    expect(queuedCount).toBe(1); // not five: one undelivered [pulse] already queued means don't enqueue another
  });

  it('drops a dead manager\'s armed timer on tick, and start() never arms a timer for a closed manager', async () => {
    const { scheduler, sessions, managers, harness, bus } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    harness.handles[0]!.emitExit(0); // close before the armed tick fires

    vi.advanceTimersByTime(1000); // the armed tick fires and finds the manager already dead
    expect(vi.getTimerCount()).toBe(0);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);

    const restarted = new PulseScheduler({ managers, sessions, bus });
    restarted.start(); // the manager record is still on disk, but its session is closed
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a manager overdue by several cadences pulses exactly once at start(), then waits a full cadence for the next one', async () => {
    const { db, bus } = setup();
    const harness = new FakeHarness();
    const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const managers = new ManagerRepository(db);
    const fiveCadencesAgo = new Date(Date.now() - 5_000).toISOString(); // pulseSeconds=1 → 5 cadences overdue
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', lastPulseAt: fiveCadencesAgo, createdAt: fiveCadencesAgo });
    const scheduler = new PulseScheduler({ managers, sessions, bus });

    scheduler.start();
    vi.advanceTimersByTime(0);
    expect(harness.handles[0]!.written).toHaveLength(1); // catches up with exactly one pulse, not five

    vi.advanceTimersByTime(999);
    expect(harness.handles[0]!.written).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.handles[0]!.written).toHaveLength(2); // the next one waits a full cadence from the catch-up pulse
  });

  it('nextPulseAt in the view matches the real armed deadline across coalesced cycles, and a restart resumes from it', async () => {
    const { db, bus } = setup();
    const harness = new FakeHarness();
    let sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    const managers = new ManagerRepository(db);
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    let scheduler = new PulseScheduler({ managers, sessions, bus });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    vi.advanceTimersByTime(1000); // cycle 1: enqueues the pulse (gated, so it stays queued)
    const afterCycle1 = managers.get(manager.id)!.lastPulseAt!;
    vi.advanceTimersByTime(1000); // cycle 2: coalesced (still queued from cycle 1)
    const afterCycle2 = managers.get(manager.id)!.lastPulseAt!;
    expect(afterCycle2).not.toBe(afterCycle1); // lastPulseAt still advances on a coalesced cycle

    const view = toManagerView(managers.get(manager.id)!, 0);
    expect(view.nextPulseAt).toBe(new Date(new Date(afterCycle2).getTime() + 1000).toISOString());

    // Restart: rebuild SessionService on the same db and confirm the cadence resumes from the persisted lastPulseAt.
    scheduler.stop();
    sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await sessions.resumeAll();
    scheduler = new PulseScheduler({ managers, sessions, bus });
    scheduler.start();

    vi.advanceTimersByTime(999);
    expect(managers.get(manager.id)!.lastPulseAt).toBe(afterCycle2); // not due yet
    vi.advanceTimersByTime(1);
    expect(managers.get(manager.id)!.lastPulseAt).not.toBe(afterCycle2); // fires exactly at the persisted deadline
  });
});
