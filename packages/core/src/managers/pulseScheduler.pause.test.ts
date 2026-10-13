import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from '../sessions/sessionService.js';
import { ManagerRepository } from './managerRepository.js';
import { ManagerService } from './managerService.js';
import { PulseScheduler } from './pulseScheduler.js';

const MISSION_NOTE_ID = 'note-mission-42';
const PULSE_SECONDS = 60;
const PULSE_INTERVAL_MS = PULSE_SECONDS * 1000;
// Short enough that the next interval lands before a pulse's turn-start guard (5 s) lapses.
const SHORT_PULSE_SECONDS = 2;

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

async function aManagerFleet({ pulseSeconds = PULSE_SECONDS }: { pulseSeconds?: number } = {}) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ managers, sessions, bus });
  const managerService = new ManagerService({ managers, sessions, bus, scheduler });
  cleanups.push(() => db.close(), () => sessions.closeAll(), () => scheduler.stop());

  const hook = (sessionId: string, hook_event_name: string) => sessions.applyInput(sessionId, { kind: 'hook', event: { session_id: sessionId, hook_event_name } as never });
  const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
  hook(manager.id, 'SessionStart');
  managers.insert({ sessionId: manager.id, pulseSeconds, childrenCap: 4, missionText: 'coordinate', createdAt: new Date().toISOString() });
  scheduler.onManagerCreated(managers.get(manager.id)!);

  const pulsesWritten = () => harness.handles[0]!.written.filter((entry) => entry.startsWith('[pulse]'));
  const humanMessagesWritten = () => harness.handles[0]!.written.filter((entry) => entry.includes('human hello'));
  const pause = () => managerService.update(manager.id, { pulseEnabled: false });
  const resume = () => managerService.update(manager.id, { pulseEnabled: true });
  const startBusyTurn = () => hook(manager.id, 'UserPromptSubmit');
  const endTurn = () => { hook(manager.id, 'Stop'); vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS); };
  const letIntervalsPass = (count: number) => vi.advanceTimersByTime(pulseSeconds * 1000 * count);
  const sendHumanMessage = () => sessions.sendMessage({ sessionId: manager.id, body: 'human hello' });
  const linkMissionNote = () => {
    const createdAt = new Date().toISOString();
    new ProjectRepository(db).insert({ id: 'project', name: 'Fleet', docsFolderPath: null, createdAt });
    new NoteRepository(db).insert({ id: MISSION_NOTE_ID, projectId: 'project', title: 'Mission', bodyMd: '# Mission', folder: null, filePath: null, sourceHash: null, rev: 1, shared: false, createdAt, updatedAt: createdAt });
    managers.setMissionNote(manager.id, MISSION_NOTE_ID);
  };
  const pulsesWrittenToAnyLaunch = () => harness.handles.flatMap((handle) => handle.written).filter((entry) => entry.startsWith('[pulse]'));
  return { db, bus, sessions, managers, harness, managerId: manager.id, pulsesWritten, pulsesWrittenToAnyLaunch, humanMessagesWritten, pause, resume, startBusyTurn, endTurn, letIntervalsPass, sendHumanMessage, linkMissionNote, scheduler, hook };
}

describe('pausing the pulses of a manager', () => {
  it('sends no interval pulse to a paused manager', async () => {
    const fleet = await aManagerFleet();

    fleet.pause();
    fleet.letIntervalsPass(5);

    expect(fleet.pulsesWritten()).toEqual([]);
  });

  it('shows the pause on the manager view', async () => {
    const fleet = await aManagerFleet();

    const pausedView = fleet.pause();
    const resumedView = fleet.resume();

    expect(pausedView?.pulseEnabled).toBe(false);
    expect(resumedView?.pulseEnabled).toBe(true);
  });

  it('refuses a manual pulse for a paused manager', async () => {
    const fleet = await aManagerFleet();
    fleet.pause();

    const manualPulse = () => fleet.scheduler.pulseNow(fleet.managerId);

    expect(manualPulse).toThrow(expect.objectContaining({ code: 'manager_paused' }));
    expect(fleet.pulsesWritten()).toEqual([]);
  });

  it('queues no wake line for a child that closes under a paused manager', async () => {
    const fleet = await aManagerFleet();
    const child = await fleet.sessions.create({ directory: '/tmp', name: 'Worker', emoji: '🤖', harness: 'fake', parentId: fleet.managerId });
    fleet.startBusyTurn();
    fleet.pause();

    await fleet.sessions.close(child.id);

    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(0);
  });

  it('drops the pulse still queued behind a busy turn', async () => {
    const fleet = await aManagerFleet();
    fleet.startBusyTurn();
    fleet.scheduler.pulseNow(fleet.managerId);
    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(1);

    fleet.pause();
    fleet.endTurn();

    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(0);
    expect(fleet.pulsesWritten()).toEqual([]);
  });

  it('keeps a human message queued behind a busy turn', async () => {
    const fleet = await aManagerFleet();
    fleet.startBusyTurn();
    fleet.scheduler.pulseNow(fleet.managerId);
    fleet.sendHumanMessage();
    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(2);

    fleet.pause();
    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(1);
    fleet.endTurn();

    expect(fleet.humanMessagesWritten()).toHaveLength(1);
    expect(fleet.pulsesWritten()).toEqual([]);
    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(0);
  });

  it('delivers a pulse already typed into the session when the pause comes', async () => {
    const fleet = await aManagerFleet();
    fleet.scheduler.pulseNow(fleet.managerId);

    fleet.pause();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(fleet.pulsesWritten()).toHaveLength(1);
  });

  it('sends the in-flight pulse and exactly one resume pulse when the pause is lifted at once', async () => {
    const fleet = await aManagerFleet();
    fleet.scheduler.pulseNow(fleet.managerId);

    fleet.pause();
    fleet.resume();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    fleet.hook(fleet.managerId, 'UserPromptSubmit');
    fleet.endTurn();
    vi.advanceTimersByTime(PULSE_INTERVAL_MS - SUBMIT_KEYSTROKE_DELAY_MS * 2 - 1);

    expect(fleet.pulsesWritten()).toHaveLength(2);
    expect(fleet.pulsesWritten()[0]).toContain('Wake reason: manual.');
    expect(fleet.pulsesWritten()[1]).toContain('Wake reason: resume.');
  });

  it('sends no resume pulse to a closed manager, and the reopened manager gets its interval pulse', async () => {
    const fleet = await aManagerFleet();
    fleet.pause();
    fleet.harness.handles[0]!.emitExit(0);

    fleet.resume();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    const pulsesWhileClosed = fleet.pulsesWrittenToAnyLaunch();
    fleet.sessions.reopen(fleet.managerId);
    fleet.hook(fleet.managerId, 'SessionStart');
    fleet.letIntervalsPass(1);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(pulsesWhileClosed).toEqual([]);
    expect(fleet.pulsesWrittenToAnyLaunch()).toHaveLength(1);
    expect(fleet.pulsesWrittenToAnyLaunch()[0]).toContain('Wake reason: interval.');
  });

  it('keeps the pause across a restart: a rebooted scheduler arms no pulse for the paused manager', async () => {
    const fleet = await aManagerFleet();
    fleet.pause();
    fleet.scheduler.stop();

    const rebootedScheduler = new PulseScheduler({ managers: new ManagerRepository(fleet.db), sessions: fleet.sessions, bus: fleet.bus });
    cleanups.push(() => rebootedScheduler.stop());
    rebootedScheduler.start();
    fleet.letIntervalsPass(5);

    expect(fleet.pulsesWritten()).toEqual([]);
  });
});

describe('resuming the pulses of a manager', () => {
  it('sends one immediate pulse that names the resume as its wake reason', async () => {
    const fleet = await aManagerFleet();
    fleet.pause();

    fleet.resume();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(fleet.pulsesWritten()).toHaveLength(1);
    expect(fleet.pulsesWritten()[0]).toContain('Wake reason: resume.');
  });

  it('waits a full interval after the resume pulse before the next interval pulse', async () => {
    const fleet = await aManagerFleet();
    fleet.pause();
    fleet.resume();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    fleet.hook(fleet.managerId, 'UserPromptSubmit');
    fleet.endTurn();

    vi.advanceTimersByTime(PULSE_INTERVAL_MS - SUBMIT_KEYSTROKE_DELAY_MS - 1);
    expect(fleet.pulsesWritten()).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(fleet.pulsesWritten()).toHaveLength(2);
    expect(fleet.pulsesWritten()[1]).toContain('Wake reason: interval.');
  });

  it('sends no pulse when the manager was not paused', async () => {
    const fleet = await aManagerFleet();

    fleet.resume();
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(fleet.pulsesWritten()).toEqual([]);
  });
});

describe('the wake reason of a pulse', () => {
  it('names the interval as the reason of a pulse that fires on schedule', async () => {
    const fleet = await aManagerFleet();

    fleet.letIntervalsPass(1);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(fleet.pulsesWritten()[0]).toContain('Wake reason: interval.');
  });

  it('names the manual trigger as the reason of a pulse requested by hand', async () => {
    const fleet = await aManagerFleet();

    fleet.scheduler.pulseNow(fleet.managerId);

    expect(fleet.pulsesWritten()[0]).toContain('Wake reason: manual.');
  });

  it('delivers one pulse carrying every reason when several triggers fire behind a turn not yet confirmed', async () => {
    const fleet = await aManagerFleet({ pulseSeconds: SHORT_PULSE_SECONDS });
    fleet.letIntervalsPass(1);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    const manualPulse = fleet.scheduler.pulseNow(fleet.managerId);
    fleet.letIntervalsPass(1);
    fleet.hook(fleet.managerId, 'UserPromptSubmit');
    fleet.endTurn();

    expect(manualPulse).toEqual({ coalesced: false });
    expect(fleet.pulsesWritten()).toHaveLength(2);
    expect(fleet.pulsesWritten()[1]).toContain('Wake reason: manual, interval.');
  });

  it('delivers one pulse carrying the new mission note id and every reason when the note gets linked while a pulse is queued', async () => {
    const fleet = await aManagerFleet({ pulseSeconds: SHORT_PULSE_SECONDS });
    fleet.letIntervalsPass(1);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    fleet.scheduler.pulseNow(fleet.managerId);

    fleet.linkMissionNote();
    fleet.letIntervalsPass(1);
    fleet.hook(fleet.managerId, 'UserPromptSubmit');
    fleet.endTurn();

    expect(fleet.pulsesWritten()).toHaveLength(2);
    expect(fleet.pulsesWritten()[1]).toContain(`Your mission note id is ${MISSION_NOTE_ID}`);
    expect(fleet.pulsesWritten()[1]).toContain('Wake reason: manual, interval.');
  });

  it('delivers nothing to a manager paused after its queued pulse changed text because a mission note got linked', async () => {
    const fleet = await aManagerFleet();
    fleet.startBusyTurn();
    fleet.scheduler.pulseNow(fleet.managerId);
    fleet.linkMissionNote();
    fleet.scheduler.pulseNow(fleet.managerId);
    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(1);

    fleet.pause();
    fleet.endTurn();

    expect(fleet.sessions.queuedMessageCount(fleet.managerId)).toBe(0);
    expect(fleet.pulsesWritten()).toEqual([]);
  });

  it('queues a new pulse once the previous one has been delivered', async () => {
    const fleet = await aManagerFleet();

    const firstPulse = fleet.scheduler.pulseNow(fleet.managerId);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);
    fleet.hook(fleet.managerId, 'UserPromptSubmit');
    fleet.endTurn();
    const secondPulse = fleet.scheduler.pulseNow(fleet.managerId);

    expect(firstPulse).toEqual({ coalesced: false });
    expect(secondPulse).toEqual({ coalesced: false });
  });
});
