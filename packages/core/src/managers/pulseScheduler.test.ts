import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from './managerRepository.js';
import { toManagerView } from './managerView.js';
import { PulseScheduler, PULSE_MESSAGE } from './pulseScheduler.js';
import { DELIVERY_RETRY_MS, MAX_DELIVERY_RETRIES, PARKED_RETRY_MS, SessionService, SUBMIT_KEYSTROKE_DELAY_MS, TURN_START_TIMEOUT_MS } from '../sessions/sessionService.js';

function setup() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ managers, sessions, bus });
  return { db, bus, harness, sessions, managers, scheduler };
}
// For tests that build their own SessionService and scheduler: a bus shared with setup()'s scheduler
// would also feed that one, which reacts to turn and close events on the same database.
const freshDatabaseAndBus = () => ({ db: openDatabase(':memory:'), bus: new EventBus() });
const hook = (session_id: string, event: object) => ({ kind: 'hook' as const, event: { session_id, ...event } as never });
// Counts pulses that have at least started (their body write landed), regardless of whether their
// separate submit keystroke has fired yet — what these cadence tests actually care about.
const pulseCount = (written: string[]) => written.filter((entry) => entry === PULSE_MESSAGE).length;

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
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);
  });

  it('holds no pulse while the manager is waiting_permission and pulses a full interval after its turn ends', async () => {
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
    vi.advanceTimersByTime(999);
    expect(harness.handles[0]!.written).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);
  });

  it('reschedules the next pulse pulseSeconds after the turn the previous one started', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });

    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(1000);
    expect(pulseCount(harness.handles[0]!.written)).toBe(1);

    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); // the pulse's own submit keystroke lands
    // On the real CLI this is what actually confirms the pulse's turn started and ended, clearing the
    // turn-start guard — without a real turn (or its timeout) the next pulse would stay held behind it.
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'UserPromptSubmit' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' }));

    vi.advanceTimersByTime(999);
    expect(pulseCount(harness.handles[0]!.written)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pulseCount(harness.handles[0]!.written)).toBe(2);
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
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE]);

    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); // the first pulse's own submit keystroke lands
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);
    // A real turn confirms the pulse landed and clears the turn-start guard, so the next scheduled pulse
    // isn't held behind it.
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'UserPromptSubmit' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' }));

    // The re-arm is anchored to the turn the manual pulse started, not the original schedule: the next
    // pulse lands a full pulseSeconds after that turn ended.
    vi.advanceTimersByTime(999);
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']); // still only one pulse started
    vi.advanceTimersByTime(1);
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r', PULSE_MESSAGE]);
  });

  it('restarting the scheduler on the same db resumes cadence from the persisted lastPulseAt', async () => {
    const { db, bus } = freshDatabaseAndBus();
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
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); // let that pulse's submit keystroke land and mark it delivered before the crash below

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
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[1]!.written).toEqual([PULSE_MESSAGE, '\r']); // cadence resumed from the persisted lastPulseAt
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

  it('a manual pulseNow right after the timer already pulsed queues behind it instead of typing into the still-unconfirmed turn, and still delivers once that turn is confirmed', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); // let the timer's own pulse fully land before the manual one
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);

    const result = scheduler.pulseNow(manager.id);

    // The manager is still idle, but no hook has yet confirmed the first pulse's turn actually started —
    // typing the manual pulse now would land in a terminal about to run that turn (Review Focus #4), so
    // it queues behind it instead of being dropped or deduplicated (still not "coalesced": that flag is
    // about an already-queued [pulse] body, and nothing was queued yet when this one was sent).
    expect(result).toEqual({ coalesced: false });
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);

    // Once a real turn starts and ends, the queued manual pulse is delivered — not silently lost.
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'UserPromptSubmit' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r', PULSE_MESSAGE]);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r', PULSE_MESSAGE, '\r']);
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
    const { db, bus } = freshDatabaseAndBus();
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
    const { db, bus } = freshDatabaseAndBus();
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
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);
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
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual([PULSE_MESSAGE, '\r']);
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

  it('reopening a closed manager resumes its pulse cadence instead of leaving it dead until the next daemon restart', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);
    harness.handles[0]!.emitExit(0); // manager closes
    vi.advanceTimersByTime(1000); // the armed tick fires, finds it dead, and clears itself
    expect(vi.getTimerCount()).toBe(0);

    sessions.reopen(manager.id); // the REST /reopen route's underlying call: state goes back to 'starting'
    expect(sessions.get(manager.id)!.state).not.toBe('closed');
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));

    // A manager brought back via reopen is alive again and should resume pulsing on its own cadence,
    // the same way one revived by a daemon restart does (PulseScheduler.start()) — but reopen() has no
    // equivalent hook, so nothing ever re-arms it.
    vi.advanceTimersByTime(1000); // one full cadence
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(pulseCount(harness.handles[1]!.written)).toBe(1);
  });

  it('a manager overdue by several cadences pulses exactly once at start(), then waits a full cadence for the next one', async () => {
    const { db, bus } = freshDatabaseAndBus();
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
    expect(pulseCount(harness.handles[0]!.written)).toBe(1); // catches up with exactly one pulse, not five

    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); // the catch-up pulse's own submit keystroke lands
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'UserPromptSubmit' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' })); // confirms the turn, clearing the turn-start guard

    vi.advanceTimersByTime(999);
    expect(pulseCount(harness.handles[0]!.written)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pulseCount(harness.handles[0]!.written)).toBe(2); // the next one waits a full cadence from the end of the catch-up turn
  });

  it('nextPulseAt in the view matches the real armed deadline across repeated cycles, and a restarted manager pulses a full cadence after it comes back', async () => {
    const { db, bus } = freshDatabaseAndBus();
    const harness = new FakeHarness();
    let sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const managers = new ManagerRepository(db);
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    let scheduler = new PulseScheduler({ managers, sessions, bus });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    vi.advanceTimersByTime(1000); // cycle 1: pulses the idle manager
    const afterCycle1 = managers.get(manager.id)!.lastPulseAt!;
    vi.advanceTimersByTime(1000); // cycle 2: pulses again, the manager stayed silent
    const afterCycle2 = managers.get(manager.id)!.lastPulseAt!;
    expect(afterCycle2).not.toBe(afterCycle1);

    const view = toManagerView(managers.get(manager.id)!, 0);
    expect(view.nextPulseAt).toBe(new Date(new Date(afterCycle2).getTime() + 1000).toISOString());

    // Restart: rebuild SessionService on the same db. The resumed CLI's SessionStart is a turn boundary like
    // any other, so the heartbeat runs a full cadence from the moment the manager is back.
    scheduler.stop();
    sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await sessions.resumeAll();
    scheduler = new PulseScheduler({ managers, sessions, bus });
    scheduler.start();
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));

    vi.advanceTimersByTime(999);
    expect(managers.get(manager.id)!.lastPulseAt).toBe(afterCycle2); // not due yet
    vi.advanceTimersByTime(1);
    expect(managers.get(manager.id)!.lastPulseAt).not.toBe(afterCycle2); // fires a full cadence after the manager came back
  });

  it('eventually delivers a pulse after a transient submit write failure, with no hook transition at all', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 3600, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    const handle = harness.handles[0]!;
    const originalWrite = handle.write.bind(handle);
    let isPtyBroken = true;
    handle.write = (data: string) => {
      if (data === '\r' && isPtyBroken) throw new Error('pty write failed');
      originalWrite(data);
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    scheduler.pulseNow(manager.id);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS + DELIVERY_RETRY_MS * MAX_DELIVERY_RETRIES);
    expect(scheduler.pulseNow(manager.id)).toEqual({ coalesced: true });

    isPtyBroken = false;
    vi.advanceTimersByTime(PARKED_RETRY_MS);
    expect(handle.written).toEqual([PULSE_MESSAGE, '\r']);
    vi.advanceTimersByTime(TURN_START_TIMEOUT_MS);

    expect(scheduler.pulseNow(manager.id)).toEqual({ coalesced: false });
    consoleErrorSpy.mockRestore();
  });

  it('logs and re-arms instead of dying when a cadence tick throws (e.g. a refused SQLite write), so the manager still pulses on its next cadence', async () => {
    const { scheduler, sessions, managers, harness } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    managers.insert({ sessionId: manager.id, pulseSeconds: 1, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    const originalSendMessage = sessions.sendMessage.bind(sessions);
    let shouldThrow = true;
    vi.spyOn(sessions, 'sendMessage').mockImplementation((...args: Parameters<typeof sessions.sendMessage>) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('sqlite write refused');
      }
      return originalSendMessage(...args);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.advanceTimersByTime(1000); // first cadence: tick() throws inside fire()

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // re-armed for the next cadence, not dropped

    vi.advanceTimersByTime(1000); // second cadence: the write succeeds this time
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(pulseCount(harness.handles[0]!.written)).toBe(1);
    consoleErrorSpy.mockRestore();
  });

  it('re-arms at a full cadence from now after each failure, not the stale past deadline, so a persistent failure fires at most once per cadence', async () => {
    const { scheduler, sessions, managers } = setup();
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    const pulseSeconds = 100;
    managers.insert({ sessionId: manager.id, pulseSeconds, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    scheduler.onManagerCreated(managers.get(manager.id)!);

    vi.spyOn(sessions, 'sendMessage').mockImplementation(() => {
      throw new Error('sqlite write refused');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cadenceMs = pulseSeconds * 1000;
    vi.advanceTimersByTime(cadenceMs); // 1st failure
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(cadenceMs - 1); // just short of the next cadence: must not have retried yet
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); // 2nd failure, exactly one cadence after the 1st
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(cadenceMs - 1); // just short of the 3rd cadence
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); // 3rd failure, exactly one cadence after the 2nd
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);

    consoleErrorSpy.mockRestore();
  });
});

describe('PulseScheduler — heartbeat and wake-ups', () => {
  const HEARTBEAT_SECONDS = 100;
  const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;

  async function idleManager() {
    const world = setup();
    const manager = await world.sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    world.sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'SessionStart' }));
    world.managers.insert({ sessionId: manager.id, pulseSeconds: HEARTBEAT_SECONDS, childrenCap: 3, missionText: 'x', createdAt: new Date().toISOString() });
    world.scheduler.onManagerCreated(world.managers.get(manager.id)!);
    const managerWrites = () => world.harness.handles[0]!.written;
    const startTurn = () => world.sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'UserPromptSubmit' }));
    const endTurn = () => world.sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' }));
    return { ...world, manager, managerWrites, startTurn, endTurn };
  }

  async function spawnChild(world: Awaited<ReturnType<typeof idleManager>>, name: string) {
    const child = await world.sessions.create({ directory: '/tmp', name, emoji: '🛠️', harness: 'fake', parentId: world.manager.id });
    const childHandle = world.harness.handles[world.harness.handles.length - 1]!;
    return { child, childHandle };
  }

  it('manager that had a turn during the interval receives no pulse at the end of it, and one a full interval after the turn', async () => {
    const { managerWrites, startTurn, endTurn } = await idleManager();

    vi.advanceTimersByTime(60_000);
    startTurn();
    endTurn();
    vi.advanceTimersByTime(HEARTBEAT_MS - 60_000);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(pulseCount(managerWrites())).toBe(0);

    vi.advanceTimersByTime(60_000 - SUBMIT_KEYSTROKE_DELAY_MS);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(pulseCount(managerWrites())).toBe(1);
  });

  it('a turn started by a human prompt restarts the interval like any other turn', async () => {
    const { managerWrites, sessions, manager } = await idleManager();

    vi.advanceTimersByTime(90_000);
    sessions.sendMessage({ sessionId: manager.id, body: 'human says hi' });
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'UserPromptSubmit' }));
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'Stop' }));
    vi.advanceTimersByTime(20_000);

    expect(pulseCount(managerWrites())).toBe(0);
  });

  it('manager busy in a long turn receives no pulse at the end of the interval and none queued for after the turn', async () => {
    const { managerWrites, startTurn, endTurn, sessions, manager } = await idleManager();

    startTurn();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(managerWrites()).toEqual([]);
    expect(sessions.queuedMessageCount(manager.id)).toBe(0);

    endTurn();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(managerWrites()).toEqual([]);
  });

  it('manager waiting on a permission receives no pulse at the end of the interval', async () => {
    const { managerWrites, sessions, manager } = await idleManager();
    sessions.applyInput(manager.id, hook(manager.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));

    vi.advanceTimersByTime(HEARTBEAT_MS);

    expect(managerWrites()).toEqual([]);
    expect(sessions.queuedMessageCount(manager.id)).toBe(0);
  });

  it('idle manager receives a pulse at the end of the interval', async () => {
    const { managerWrites } = await idleManager();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(pulseCount(managerWrites())).toBe(1);
  });

  it('closed manager receives no pulse', async () => {
    const { managerWrites, harness } = await idleManager();
    harness.handles[0]!.emitExit(0);

    vi.advanceTimersByTime(HEARTBEAT_MS * 3);

    expect(managerWrites()).toEqual([]);
  });

  it('child message to an idle manager starts its turn at once, without waiting for the pulse', async () => {
    const world = await idleManager();
    const { child } = await spawnChild(world, 'Gimli');

    world.sessions.sendMessage({ sessionId: world.manager.id, body: 'need a decision', fromSessionId: child.id });

    expect(world.managerWrites().some((entry) => entry.includes('need a decision'))).toBe(true);
  });

  it('manager receives exactly one line when its child closes, marked like a pulse', async () => {
    const world = await idleManager();
    const { childHandle } = await spawnChild(world, 'Gimli');

    childHandle.emitExit(3);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(world.managerWrites()).toEqual(['[pulse] Child "Gimli" closed (exit code 3).', '\r']);
  });

  it('close of a child by a plain close wakes the manager with one line', async () => {
    const world = await idleManager();
    const { child } = await spawnChild(world, 'Gimli');

    await world.sessions.close(child.id);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    const wakeLines = world.managerWrites().filter((entry) => entry.startsWith('[pulse] Child'));
    expect(wakeLines).toHaveLength(1);
  });

  it('close of a child that reports no exit code says the exit code is unknown', async () => {
    const world = await idleManager();
    const { child } = await spawnChild(world, 'Gimli');

    world.bus.emit({ type: 'session.closed', sessionId: child.id });
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(world.managerWrites()).toEqual(['[pulse] Child "Gimli" closed (exit code unknown).', '\r']);
  });

  it('close of a child restarts the manager interval like the turn it starts', async () => {
    const world = await idleManager();
    const { childHandle } = await spawnChild(world, 'Gimli');
    vi.advanceTimersByTime(90_000);

    childHandle.emitExit(0);
    world.startTurn();
    world.endTurn();
    vi.advanceTimersByTime(20_000);

    expect(pulseCount(world.managerWrites())).toBe(0);
  });

  it('close of a session that is not a manager\'s child wakes nobody', async () => {
    const world = await idleManager();
    await world.sessions.create({ directory: '/tmp', name: 'Loner', emoji: '🐺', harness: 'fake' });
    const lonerHandle = world.harness.handles[1]!;

    lonerHandle.emitExit(0);

    expect(world.managerWrites()).toEqual([]);
  });

  it('close of a child whose manager already closed neither throws, writes nor logs an error', async () => {
    const world = await idleManager();
    const { childHandle } = await spawnChild(world, 'Gimli');
    world.harness.handles[0]!.emitExit(0);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => childHandle.emitExit(0)).not.toThrow();

    expect(world.managerWrites()).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('close of a child of a plain session, one that is no manager, wakes nobody', async () => {
    const world = await idleManager();
    const plainParent = await world.sessions.create({ directory: '/tmp', name: 'Plain', emoji: '🙂', harness: 'fake' });
    const plainParentHandle = world.harness.handles[1]!;
    world.sessions.applyInput(plainParent.id, hook(plainParent.id, { hook_event_name: 'SessionStart' }));
    await world.sessions.create({ directory: '/tmp', name: 'Kid', emoji: '🧒', harness: 'fake', parentId: plainParent.id });
    const kidHandle = world.harness.handles[2]!;

    kidHandle.emitExit(0);

    expect(plainParentHandle.written).toEqual([]);
  });

  it('a child closing while the daemon shuts down leaves no wake line for its manager', async () => {
    const world = await idleManager();
    const { childHandle } = await spawnChild(world, 'Gimli');
    world.scheduler.stop();

    childHandle.emitExit(0);

    expect(world.managerWrites()).toEqual([]);
    expect(world.sessions.queuedMessageCount(world.manager.id)).toBe(0);
  });

  it('close of the manager itself sends no wake line', async () => {
    const world = await idleManager();

    world.harness.handles[0]!.emitExit(0);

    expect(world.managerWrites()).toEqual([]);
  });

  describe('wake lines queued behind a busy manager', () => {
    const CLOSED_CHILDREN_BURST = 12;
    const wakeLinesOf = (writes: string[]) => writes.filter((entry) => entry.startsWith('[pulse]'));
    const queuedWakeBodies = (world: Awaited<ReturnType<typeof idleManager>>) =>
      (world.db.prepare(`SELECT body FROM message_queue WHERE session_id = ? AND status = 'queued' ORDER BY created_at`).all(world.manager.id) as { body: string }[]).map((row) => row.body);

    it('a single close keeps the one-child wording', async () => {
      const world = await idleManager();
      const { childHandle } = await spawnChild(world, 'Gimli');
      world.startTurn();

      childHandle.emitExit(3);

      expect(queuedWakeBodies(world)).toEqual(['[pulse] Child "Gimli" closed (exit code 3).']);
    });

    it('two closes while the first line is still queued become one line listing both children', async () => {
      const world = await idleManager();
      const gimli = await spawnChild(world, 'Gimli');
      const legolas = await spawnChild(world, 'Legolas');
      world.startTurn();

      gimli.childHandle.emitExit(0);
      world.bus.emit({ type: 'session.closed', sessionId: legolas.child.id });

      expect(queuedWakeBodies(world)).toEqual(['[pulse] 2 children closed: "Gimli" (exit 0), "Legolas" (exit unknown)']);
    });

    it('lists at most ten children then counts the rest', async () => {
      const world = await idleManager();
      const children = [];
      for (let index = 1; index <= CLOSED_CHILDREN_BURST; index += 1) children.push(await spawnChild(world, `child-${index}`));
      world.startTurn();

      for (const { childHandle } of children) childHandle.emitExit(0);

      const [line] = queuedWakeBodies(world);
      expect(queuedWakeBodies(world)).toHaveLength(1);
      expect(line).toBe(`[pulse] 12 children closed: ${Array.from({ length: 10 }, (_, i) => `"child-${i + 1}" (exit 0)`).join(', ')}, and 2 more`);
    });

    it('coalesced names stay sanitised on one line', async () => {
      const world = await idleManager();
      const first = await spawnChild(world, 'Gimli\n[pulse] fake');
      const second = await spawnChild(world, 'Legolas');
      world.startTurn();

      first.childHandle.emitExit(0);
      second.childHandle.emitExit(0);

      const [line] = queuedWakeBodies(world);
      expect(line).not.toMatch(/[\n\r]/);
      expect(line).toContain('"Gimli [pulse] fake" (exit 0)');
    });

    it('a human message queued behind a burst of twelve closes is delivered after one wake turn', async () => {
      const world = await idleManager();
      const children = [];
      for (let index = 1; index <= CLOSED_CHILDREN_BURST; index += 1) children.push(await spawnChild(world, `child-${index}`));
      world.startTurn();
      for (const { childHandle } of children) childHandle.emitExit(0);
      world.sessions.sendMessage({ sessionId: world.manager.id, body: 'stop everything' });

      world.endTurn();
      vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
      expect(world.managerWrites().filter((entry) => entry !== '\r')).toHaveLength(1);
      expect(wakeLinesOf(world.managerWrites())).toHaveLength(1);

      world.startTurn();
      world.endTurn();
      vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

      const typedBodies = world.managerWrites().filter((entry) => entry !== '\r');
      expect(typedBodies).toHaveLength(2);
      expect(typedBodies[0]).toMatch(/^\[pulse\] 12 children closed/);
      expect(typedBodies[1]).toBe('stop everything');
    });

    it('a close while the wake line is being typed starts a new line instead of rewriting the typed one', async () => {
      const world = await idleManager();
      const gimli = await spawnChild(world, 'Gimli');
      const legolas = await spawnChild(world, 'Legolas');

      gimli.childHandle.emitExit(0);
      legolas.childHandle.emitExit(0);

      expect(world.managerWrites()).toEqual(['[pulse] Child "Gimli" closed (exit code 0).']);
      expect(queuedWakeBodies(world)).toEqual(['[pulse] Child "Gimli" closed (exit code 0).', '[pulse] Child "Legolas" closed (exit code 0).']);
    });

    it('a close after the wake line was typed starts a new line instead of rewriting the delivered one', async () => {
      const world = await idleManager();
      const gimli = await spawnChild(world, 'Gimli');
      const legolas = await spawnChild(world, 'Legolas');

      gimli.childHandle.emitExit(0);
      vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
      legolas.childHandle.emitExit(0);

      expect(queuedWakeBodies(world)).toEqual(['[pulse] Child "Legolas" closed (exit code 0).']);
    });
  });

  describe('closes the manager asked for', () => {
    it('closing five children through their parent wakes the manager with no line', async () => {
      const world = await idleManager();
      world.startTurn();
      const children = [];
      for (let index = 1; index <= 5; index += 1) children.push(await spawnChild(world, `child-${index}`));

      for (const { child } of children) await world.sessions.close(child.id, { closedByParent: true });

      expect(world.sessions.queuedMessageCount(world.manager.id)).toBe(0);
      expect(world.managerWrites()).toEqual([]);
    });

    it('a child closed by the human wakes the manager with one line', async () => {
      const world = await idleManager();
      world.startTurn();
      const { child } = await spawnChild(world, 'Gimli');

      await world.sessions.close(child.id);

      expect(world.sessions.queuedMessageCount(world.manager.id)).toBe(1);
    });

    it('a child that crashes wakes the manager with one line', async () => {
      const world = await idleManager();
      world.startTurn();
      const { childHandle } = await spawnChild(world, 'Gimli');

      childHandle.emitExit(139);

      expect(world.sessions.queuedMessageCount(world.manager.id)).toBe(1);
    });

    it('a child crashing after the manager asked to close another one still wakes it', async () => {
      const world = await idleManager();
      world.startTurn();
      const closedByManager = await spawnChild(world, 'Gimli');
      const crashing = await spawnChild(world, 'Legolas');

      await world.sessions.close(closedByManager.child.id, { closedByParent: true });
      crashing.childHandle.emitExit(1);

      expect(world.sessions.queuedMessageCount(world.manager.id)).toBe(1);
    });
  });

  describe('a manager row outside the bounds', () => {
    const LEGACY_PULSE_SECONDS = 3_000_000;

    async function managerWithLegacyRow() {
      const world = setup();
      const manager = await world.sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
      world.managers.insert({ sessionId: manager.id, pulseSeconds: LEGACY_PULSE_SECONDS, childrenCap: 3, missionText: 'x', createdAt: new Date().toISOString() });
      return { ...world, manager };
    }

    it('a state change arms no timer', async () => {
      const world = await managerWithLegacyRow();

      world.sessions.applyInput(world.manager.id, hook(world.manager.id, { hook_event_name: 'SessionStart' }));
      world.sessions.applyInput(world.manager.id, hook(world.manager.id, { hook_event_name: 'UserPromptSubmit' }));

      expect(vi.getTimerCount()).toBe(0);
    });

    it('a busy tick never re-arms it every millisecond', async () => {
      const world = await managerWithLegacyRow();
      world.sessions.applyInput(world.manager.id, hook(world.manager.id, { hook_event_name: 'SessionStart' }));
      world.scheduler.onManagerCreated(world.managers.get(world.manager.id)!);

      vi.advanceTimersByTime(10_000);

      expect(world.harness.handles[0]!.written).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a manual pulse is refused', async () => {
      const world = await managerWithLegacyRow();
      world.sessions.applyInput(world.manager.id, hook(world.manager.id, { hook_event_name: 'SessionStart' }));

      expect(world.scheduler.pulseNow(world.manager.id)).toBeUndefined();
    });
  });

  describe('timer delay ceiling', () => {
    const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

    it('a last pulse far in the future never arms a delay Node would clamp to one millisecond', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const world = setup();
      const manager = await world.sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
      const farFuture = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
      world.managers.insert({ sessionId: manager.id, pulseSeconds: 100, childrenCap: 3, missionText: 'x', lastPulseAt: farFuture, createdAt: new Date().toISOString() });
      setTimeoutSpy.mockClear();

      world.scheduler.onManagerCreated(world.managers.get(manager.id)!);

      const armedDelays = setTimeoutSpy.mock.calls.map(([, delay]) => delay as number);
      expect(armedDelays.length).toBeGreaterThan(0);
      expect(Math.max(...armedDelays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
      setTimeoutSpy.mockRestore();
    });
  });

  describe('a manager waiting on the human', () => {
    async function managerWaitingInput() {
      const world = await idleManager();
      world.sessions.applyInput(world.manager.id, hook(world.manager.id, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' }));
      return world;
    }

    it('a child closing queues its wake line instead of typing it', async () => {
      const world = await managerWaitingInput();
      const { childHandle } = await spawnChild(world, 'Gimli');
      expect(world.sessions.get(world.manager.id)!.state).toBe('waiting_input');

      childHandle.emitExit(0);
      vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

      expect(world.managerWrites()).toEqual([]);
      expect(world.sessions.queuedMessageCount(world.manager.id)).toBe(1);
    });

    it('the queued wake line is typed once the manager is idle again', async () => {
      const world = await managerWaitingInput();
      const { childHandle } = await spawnChild(world, 'Gimli');
      childHandle.emitExit(0);

      world.endTurn();
      vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

      expect(world.managerWrites()).toEqual(['[pulse] Child "Gimli" closed (exit code 0).', '\r']);
    });

    it('a human message still reaches the composer while a wake line is held', async () => {
      const world = await managerWaitingInput();
      const { childHandle } = await spawnChild(world, 'Gimli');
      childHandle.emitExit(0);

      world.sessions.sendMessage({ sessionId: world.manager.id, body: 'yes, go ahead' });

      expect(world.managerWrites()).toEqual(['yes, go ahead']);
    });
  });
});
