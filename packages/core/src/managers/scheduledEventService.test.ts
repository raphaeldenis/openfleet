import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from '../sessions/sessionService.js';
import { ManagerRepository } from './managerRepository.js';
import { ManagerService } from './managerService.js';
import { PulseScheduler } from './pulseScheduler.js';
import { localDateTimeOf } from './localDateTime.js';
import { ScheduledEventRepository } from './scheduledEventRepository.js';
import { DELIVERY_RETRY_DELAY_MS, MAX_PENDING_EVENTS_PER_MANAGER, MAX_EVENT_MESSAGE_BYTES, ScheduledEventService } from './scheduledEventService.js';

const MINUTE_MS = 60_000;
const PULSE_SECONDS = 3600;

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

async function aFleetWithAManager() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const pulses = new PulseScheduler({ managers, sessions, bus });
  const managerService = new ManagerService({ managers, sessions, bus, scheduler: pulses });
  const repository = new ScheduledEventRepository(db);
  const events = new ScheduledEventService({ repository, sessions, managers, bus });
  cleanups.push(() => db.close(), () => sessions.closeAll(), () => pulses.stop(), () => events.stop());

  const hook = (sessionId: string, hook_event_name: string) => sessions.applyInput(sessionId, { kind: 'hook', event: { session_id: sessionId, hook_event_name } as never });
  const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
  hook(manager.id, 'SessionStart');
  managers.insert({ sessionId: manager.id, pulseSeconds: PULSE_SECONDS, childrenCap: 4, missionText: 'coordinate', createdAt: new Date().toISOString() });

  const eventLinesWritten = () => harness.handles.flatMap((handle) => handle.written).filter((entry) => entry.startsWith('[scheduled event'));
  const letTimePass = (milliseconds: number) => { vi.advanceTimersByTime(milliseconds); vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); };
  const inMinutes = (minutes: number) => localDateTimeOf(new Date(Date.now() + minutes * MINUTE_MS));
  return {
    db, bus, sessions, managers, repository, events, harness, managerId: manager.id, eventLinesWritten, letTimePass, inMinutes,
    startBusyTurn: () => hook(manager.id, 'UserPromptSubmit'),
    endTurn: () => { hook(manager.id, 'Stop'); vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); },
    pause: () => managerService.update(manager.id, { pulseEnabled: false }),
    disable: () => managerService.update(manager.id, { mode: 'disabled' }),
    resume: () => managerService.update(manager.id, { pulseEnabled: true }),
    schedule: (input: { message?: string; title?: string; at?: string; inMinutes?: number; creator?: 'manager' | 'human' } = {}) =>
      events.schedule({ managerId: manager.id, creator: 'manager', message: 'check the nightly run', ...input }),
  };
}

describe('scheduling a manager event', () => {
  it('delivers the message to the manager at its due time with the scheduled-event prefix, not the pulse prefix', async () => {
    const fleet = await aFleetWithAManager();

    fleet.schedule({ inMinutes: 10, message: 'check the nightly run', title: 'Nightly' });
    fleet.letTimePass(9 * MINUTE_MS);
    expect(fleet.eventLinesWritten()).toEqual([]);
    fleet.letTimePass(2 * MINUTE_MS);

    const [line] = fleet.eventLinesWritten();
    expect(line).toMatch(/^\[scheduled event "Nightly", due \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\] check the nightly run/);
    expect(line).not.toContain('delivered late');
    expect(line).not.toMatch(/^\[pulse\]/);
  });

  it('accepts a local time without offset in `at`', async () => {
    const fleet = await aFleetWithAManager();

    const scheduled = fleet.schedule({ at: fleet.inMinutes(5) });

    expect(new Date(scheduled.dueAt).getTime() - Date.now()).toBeGreaterThan(4 * MINUTE_MS);
    expect(new Date(scheduled.dueAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * MINUTE_MS);
  });

  it('accepts a local time without seconds in `at` and reads it as second 0', async () => {
    const fleet = await aFleetWithAManager();
    const dueToTheMinute = new Date(Date.now() + 5 * MINUTE_MS);
    const atWithoutSeconds = localDateTimeOf(dueToTheMinute).slice(0, 'YYYY-MM-DDTHH:MM'.length);

    const scheduled = fleet.schedule({ at: atWithoutSeconds });

    expect(new Date(scheduled.dueAt).getSeconds()).toBe(0);
  });

  it('retries a due event 60 s after sendMessage throws, then delivers it once', async () => {
    const fleet = await aFleetWithAManager();
    const sendMessage = vi.spyOn(fleet.sessions, 'sendMessage').mockImplementationOnce(() => { throw new Error('queue unavailable'); });
    fleet.schedule({ inMinutes: 1 });

    fleet.letTimePass(MINUTE_MS + 1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(fleet.events.pendingOf(fleet.managerId)).toHaveLength(1);
    fleet.letTimePass(DELIVERY_RETRY_DELAY_MS);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(fleet.eventLinesWritten()).toHaveLength(1);
    expect(fleet.events.pendingOf(fleet.managerId)).toEqual([]);
  });

  it('is one-shot: the event leaves the pending list once delivered and is never delivered twice', async () => {
    const fleet = await aFleetWithAManager();
    fleet.schedule({ inMinutes: 1 });

    fleet.letTimePass(2 * MINUTE_MS);
    fleet.letTimePass(60 * MINUTE_MS);

    expect(fleet.eventLinesWritten()).toHaveLength(1);
    expect(fleet.events.pendingOf(fleet.managerId)).toEqual([]);
  });

  it('waits for the end of a running turn before the manager reads it', async () => {
    const fleet = await aFleetWithAManager();
    fleet.startBusyTurn();
    fleet.schedule({ inMinutes: 1 });

    fleet.letTimePass(2 * MINUTE_MS);
    expect(fleet.eventLinesWritten()).toEqual([]);
    fleet.endTurn();

    expect(fleet.eventLinesWritten()).toHaveLength(1);
  });

  it('keeps the event queued across a restart of the service and delivers it late with its due time visible', async () => {
    const fleet = await aFleetWithAManager();
    fleet.schedule({ inMinutes: 5, title: 'Closed app' });
    fleet.events.stop();

    vi.advanceTimersByTime(3 * 60 * MINUTE_MS); // the app was closed for 3 hours
    const restarted = new ScheduledEventService({ repository: fleet.repository, sessions: fleet.sessions, managers: fleet.managers, bus: fleet.bus });
    cleanups.push(() => restarted.stop());
    restarted.start();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    const [line] = fleet.eventLinesWritten();
    expect(line).toMatch(/^\[scheduled event "Closed app", due \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}, delivered late\]/);
  });

  it('holds the event while the manager session is closed and replays it when the session is reopened', async () => {
    const fleet = await aFleetWithAManager();
    fleet.schedule({ inMinutes: 1 });
    fleet.harness.handles[0]!.emitExit(0);

    fleet.letTimePass(5 * MINUTE_MS);
    expect(fleet.eventLinesWritten()).toEqual([]);
    expect(fleet.events.pendingOf(fleet.managerId)).toHaveLength(1);
    fleet.sessions.reopen(fleet.managerId);
    fleet.sessions.applyInput(fleet.managerId, { kind: 'hook', event: { session_id: fleet.managerId, hook_event_name: 'SessionStart' } as never });
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(fleet.eventLinesWritten()).toHaveLength(1);
    expect(fleet.eventLinesWritten()[0]).toContain('delivered late');
  });

  it('holds the event while the manager is disabled and replays it on reactivation', async () => {
    const fleet = await aFleetWithAManager();
    fleet.disable();
    fleet.schedule({ inMinutes: 1 });

    fleet.letTimePass(5 * MINUTE_MS);
    expect(fleet.eventLinesWritten()).toEqual([]);
    fleet.resume();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(fleet.eventLinesWritten()).toHaveLength(1);
  });

  it('delivers the event to a sleeping manager at its due time', async () => {
    const fleet = await aFleetWithAManager();
    fleet.pause();
    fleet.schedule({ inMinutes: 1 });

    fleet.letTimePass(5 * MINUTE_MS);

    expect(fleet.eventLinesWritten()).toHaveLength(1);
  });
});

describe('listing and cancelling manager events', () => {
  it('lists the pending events of a manager, soonest first', async () => {
    const fleet = await aFleetWithAManager();
    fleet.schedule({ inMinutes: 30, message: 'later' });
    fleet.schedule({ inMinutes: 10, message: 'sooner' });

    expect(fleet.events.pendingOf(fleet.managerId).map((event) => event.message)).toEqual(['sooner', 'later']);
  });

  it('never delivers a cancelled event', async () => {
    const fleet = await aFleetWithAManager();
    const { id } = fleet.schedule({ inMinutes: 1 });

    fleet.events.cancel({ managerId: fleet.managerId, eventId: id, actor: 'manager' });
    fleet.letTimePass(5 * MINUTE_MS);

    expect(fleet.eventLinesWritten()).toEqual([]);
    expect(fleet.events.pendingOf(fleet.managerId)).toEqual([]);
  });

  it('refuses a cancel by an actor other than the creator and keeps the event', async () => {
    const fleet = await aFleetWithAManager();
    const { id } = fleet.schedule({ inMinutes: 1, creator: 'human' });

    const cancelByManager = () => fleet.events.cancel({ managerId: fleet.managerId, eventId: id, actor: 'manager' });

    expect(cancelByManager).toThrow(expect.objectContaining({ code: 'outside_lineage' }));
    fleet.letTimePass(2 * MINUTE_MS);
    expect(fleet.eventLinesWritten()).toHaveLength(1);
  });

  it('answers not_found for an unknown event and for the event of another manager', async () => {
    const fleet = await aFleetWithAManager();
    const { id } = fleet.schedule({ inMinutes: 1 });

    const cancelUnknown = () => fleet.events.cancel({ managerId: fleet.managerId, eventId: 'nope', actor: 'manager' });
    const cancelOfAnotherManager = () => fleet.events.cancel({ managerId: 'another-manager', eventId: id, actor: 'manager' });

    expect(cancelUnknown).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(cancelOfAnotherManager).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('refusals when scheduling', () => {
  it('refuses a time in the past', async () => {
    const fleet = await aFleetWithAManager();

    const schedulePast = () => fleet.schedule({ at: fleet.inMinutes(-5) });

    expect(schedulePast).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });

  it('refuses `at` and `in_minutes` together', async () => {
    const fleet = await aFleetWithAManager();

    const scheduleBoth = () => fleet.schedule({ at: fleet.inMinutes(5), inMinutes: 5 });

    expect(scheduleBoth).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });

  it('refuses a call with neither `at` nor `in_minutes`', async () => {
    const fleet = await aFleetWithAManager();

    expect(() => fleet.schedule({})).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });

  it.each(['2030-01-01T09:30:00Z', '2030-01-01T09:30:00+02:00', 'tomorrow'])('refuses `at` %s: it is a local time without offset', async (at) => {
    const fleet = await aFleetWithAManager();

    expect(() => fleet.schedule({ at })).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });

  it('refuses a message above the length cap', async () => {
    const fleet = await aFleetWithAManager();

    const scheduleTooLong = () => fleet.schedule({ inMinutes: 5, message: 'x'.repeat(MAX_EVENT_MESSAGE_BYTES + 1) });

    expect(scheduleTooLong).toThrow(expect.objectContaining({ code: 'message_too_long' }));
  });

  it('refuses an empty message', async () => {
    const fleet = await aFleetWithAManager();

    expect(() => fleet.schedule({ inMinutes: 5, message: '   ' })).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });

  it('refuses a new event once the manager has the maximum of pending events, and frees a place when one is cancelled', async () => {
    const fleet = await aFleetWithAManager();
    const first = fleet.schedule({ inMinutes: 5 });
    for (let index = 1; index < MAX_PENDING_EVENTS_PER_MANAGER; index += 1) fleet.schedule({ inMinutes: 5 });

    const scheduleOneMore = () => fleet.schedule({ inMinutes: 5 });

    expect(scheduleOneMore).toThrow(expect.objectContaining({ code: 'too_many_pending' }));
    fleet.events.cancel({ managerId: fleet.managerId, eventId: first.id, actor: 'manager' });
    expect(scheduleOneMore).not.toThrow();
  });
});
