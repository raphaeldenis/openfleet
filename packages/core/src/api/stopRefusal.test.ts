import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkingStateSections } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { StopRefusal } from '../workingState/stopRefusal.js';
import type { WorkingStateSettings } from '../workingState/workingStateSettings.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { startServer } from './server.js';

const MINUTE_MS = 60_000;
const STATE_WITH_ONE_TODO: WorkingStateSections = { plan: ['ship'], todo: ['write tests'], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] };

interface Fixture {
  server: Awaited<ReturnType<typeof startServer>>;
  db: DatabaseSync;
  sessions: SessionService;
  harness: FakeHarness;
  workingStates: WorkingStateService;
  setNow: (epochMs: number) => void;
  now: () => number;
}

let fx: Fixture;
let sessionId: string;
let hookToken: string;

async function startFixture(settings: Partial<WorkingStateSettings> = {}, stopRefusalOverride?: StopRefusal): Promise<Fixture> {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  let nowMs = Date.now();
  const clock = () => new Date(nowMs).toISOString();
  const workingStateSettings: WorkingStateSettings = { maxBytes: 6144, enforce: true, maxAgeMinutes: 30, ...settings };
  const workingStates = new WorkingStateService({ db, clock, stateRoot: mkdtempSync(join(tmpdir(), 'of-stop-mirror-')), maxBytes: workingStateSettings.maxBytes });
  const stopRefusal = stopRefusalOverride ?? new StopRefusal({ db, workingStates, settings: workingStateSettings, clock });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', stopRefusal });
  return { server, db, sessions, harness, workingStates, setNow: (epochMs) => { nowMs = epochMs; }, now: () => nowMs };
}

const hookTokenOf = (id: string) => (fx.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const postHook = async (body: Record<string, unknown>, token = hookToken) => {
  const response = await fetch(`${fx.server.url}/hooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<{ decision?: string; reason?: string }>;
};
const promptSubmitted = () => postHook({ hook_event_name: 'UserPromptSubmit' });
const stop = (extra: Record<string, unknown> = {}) => postHook({ hook_event_name: 'Stop', ...extra });
const stateOfSession = () => fx.sessions.list().find((session) => session.id === sessionId)!.state;
const typedBodies = () => fx.harness.handles.flatMap((handle) => handle.written);

beforeEach(async () => {
  fx = await startFixture();
  const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
  sessionId = session.id;
  hookToken = hookTokenOf(session.id);
});
afterEach(() => fx.server.close());

describe('user can rely on the daemon refusing the end of a turn while the working state is not current', () => {
  it('refuses the turn end of a session with no state, naming the tool and the six sections', async () => {
    await promptSubmitted();

    const answer = await stop();

    expect(answer.decision).toBe('block');
    expect(answer.reason).toContain('update_working_state');
    for (const section of ['plan', 'todo', 'remaining', 'questions_for_human', 'internal_questions', 'blockers']) expect(answer.reason).toContain(section);
  });

  it('refuses a state 31 minutes old, names its age, and lets a state 29 minutes old end the turn', async () => {
    const writtenAt = fx.now();
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);

    fx.setNow(writtenAt + 29 * MINUTE_MS);
    const at29Minutes = await stop();
    fx.setNow(writtenAt + 31 * MINUTE_MS);
    const at31Minutes = await stop();

    expect(at29Minutes).toEqual({});
    expect(at31Minutes.decision).toBe('block');
    expect(at31Minutes.reason).toContain('31 minutes');
  });

  it('never refuses a Stop that continues an earlier refusal, whatever the state', async () => {
    const firstStop = await stop();
    const continuedStop = await stop({ stop_hook_active: true });

    expect(firstStop.decision).toBe('block');
    expect(continuedStop).toEqual({});
  });

  it('never refuses a Stop with stop_hook_active even with a stale, oversize state and a stale fleet', async () => {
    const bigState: WorkingStateSections = { ...STATE_WITH_ONE_TODO, todo: Array.from({ length: 40 }, (_, index) => `item ${index} ${'x'.repeat(200)}`) };
    const writtenAt = fx.now();
    fx.setNow(writtenAt - 5 * MINUTE_MS);
    fx.db.prepare('INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(sessionId, JSON.stringify(bigState), new Date(fx.now()).toISOString());
    fx.setNow(writtenAt);
    await fx.sessions.create({ directory: '/tmp', name: 'Late-child', harness: 'fake', emoji: '🧒', parentId: sessionId });
    fx.setNow(writtenAt + 600 * MINUTE_MS);

    const withoutContinuation = await stop();
    const withContinuation = await stop({ stop_hook_active: true });

    expect(withoutContinuation.decision).toBe('block');
    expect(withoutContinuation.reason).toContain('605 minutes');
    expect(withContinuation).toEqual({});
  });

  it('names the fleet, not the size, when the state is oversize and predates a child, and the size when the fleet is unchanged', async () => {
    const bigState: WorkingStateSections = { ...STATE_WITH_ONE_TODO, todo: Array.from({ length: 40 }, (_, index) => `item ${index} ${'x'.repeat(200)}`) };
    const writtenAt = fx.now();
    fx.setNow(writtenAt - 5 * MINUTE_MS);
    fx.db.prepare('INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(sessionId, JSON.stringify(bigState), new Date(fx.now()).toISOString());
    fx.setNow(writtenAt);
    await fx.sessions.create({ directory: '/tmp', name: 'Late-child', harness: 'fake', emoji: '🧒', parentId: sessionId });
    fx.setNow(writtenAt + 1_000);

    const oversizeAndFleetStale = await stop();
    fx.db.prepare('UPDATE session_working_states SET updated_at = ? WHERE session_id = ?').run(new Date(writtenAt + 500).toISOString(), sessionId);
    const oversizeOnly = await stop();

    expect(oversizeAndFleetStale.reason).toContain('Late-child');
    expect(oversizeAndFleetStale.reason).not.toContain('bytes');
    expect(oversizeOnly.reason).toMatch(/\d+ bytes/);
  });

  it('lets the turn end when the state is current', async () => {
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);

    expect(await stop()).toEqual({});
  });

  it('keeps refusing once per turn: a refused turn then an accepted Stop ends normally, and the next turn is refused again when the state went stale', async () => {
    const writtenAt = fx.now();
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);
    fx.setNow(writtenAt + 40 * MINUTE_MS);

    const refused = await stop();
    const accepted = await stop({ stop_hook_active: true });
    const nextTurnRefused = await stop();

    expect([refused.decision, accepted.decision, nextTurnRefused.decision]).toEqual(['block', undefined, 'block']);
  });
});

describe('user can see a manager refused until its state matches its fleet', () => {
  it('refuses a manager whose fresh state predates a child it spawned, names the child, and accepts it after an update', async () => {
    const writtenAt = fx.now();
    fx.setNow(writtenAt - 2 * MINUTE_MS);
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);
    fx.setNow(writtenAt);
    await fx.sessions.create({ directory: '/tmp', name: 'Scout-7', harness: 'fake', emoji: '🔎', parentId: sessionId });
    fx.setNow(writtenAt + 1_000);

    const refused = await stop();
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);
    const accepted = await stop();

    expect(refused.decision).toBe('block');
    expect(refused.reason).toContain('Scout-7');
    expect(refused.reason).toContain('spawned');
    expect(accepted).toEqual({});
  });

  it('refuses a manager whose child was closed by the human after the state was written, naming it as closed', async () => {
    const child = await fx.sessions.create({ directory: '/tmp', name: 'Builder-3', harness: 'fake', emoji: '🔨', parentId: sessionId });
    fx.setNow(Date.now() + 1);
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await fx.sessions.close(child.id);
    fx.setNow(Date.now() + 1_000);

    const refused = await stop();

    expect(refused.decision).toBe('block');
    expect(refused.reason).toContain('Builder-3');
    expect(refused.reason).toContain('closed');
  });

  it('names at most 10 children and counts the others', async () => {
    fx.setNow(fx.now() - 5 * MINUTE_MS);
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);
    fx.setNow(fx.now() + 5 * MINUTE_MS);
    for (let index = 1; index <= 13; index++) await fx.sessions.create({ directory: '/tmp', name: `Kid-${String(index).padStart(2, '0')}`, harness: 'fake', emoji: '🧒', parentId: sessionId });

    const refused = await stop();

    const namedChildren = refused.reason!.match(/Kid-\d\d/g) ?? [];
    expect(namedChildren).toHaveLength(10);
    expect(refused.reason).toContain('and 3 more');
  });
});

describe('user can rely on an oversize stored state being refused at the turn end', () => {
  it('refuses a stored state larger than the cap in force with its size, the cap and the instruction; a shorter state ends the turn', async () => {
    const bigState: WorkingStateSections = { ...STATE_WITH_ONE_TODO, todo: Array.from({ length: 12 }, (_, index) => `item ${index} ${'x'.repeat(200)}`) };
    await fx.server.close();
    fx = await startFixture({ maxBytes: 1024 });
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    sessionId = session.id;
    hookToken = hookTokenOf(session.id);
    fx.db.prepare('INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(sessionId, JSON.stringify(bigState), new Date(fx.now()).toISOString());

    const refused = await stop();
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);
    const accepted = await stop();

    expect(refused.decision).toBe('block');
    expect(refused.reason).toMatch(/\d+ bytes/);
    expect(refused.reason).toContain('1024');
    expect(refused.reason).toContain('move history to the log');
    expect(accepted).toEqual({});
    expect(await stop({ stop_hook_active: true })).toEqual({});
  });

  it('follows maxBytes: 2048 for the refusal at the turn end', async () => {
    await fx.server.close();
    fx = await startFixture({ maxBytes: 2048 });
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    sessionId = session.id;
    hookToken = hookTokenOf(session.id);
    const stateOf = (todoCount: number) => ({ ...STATE_WITH_ONE_TODO, todo: Array.from({ length: todoCount }, () => 'y'.repeat(250)) });
    fx.workingStates.update(sessionId, stateOf(7));
    fx.db.prepare('UPDATE session_working_states SET sections_json = ? WHERE session_id = ?').run(JSON.stringify(stateOf(9)), sessionId);

    const refused = await stop();

    expect(refused.decision).toBe('block');
    expect(refused.reason).toContain('2048');
  });
});

describe('user can turn the refusal off or shorten the age limit in config.json', () => {
  it('lets every turn end when enforce is false, even with no state', async () => {
    await fx.server.close();
    fx = await startFixture({ enforce: false });
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    hookToken = hookTokenOf(session.id);

    expect(await stop()).toEqual({});
  });

  it('refuses a 6 minute old state when maxAgeMinutes is 5, and not a 4 minute old one', async () => {
    await fx.server.close();
    fx = await startFixture({ maxAgeMinutes: 5 });
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    sessionId = session.id;
    hookToken = hookTokenOf(session.id);
    const writtenAt = fx.now();
    fx.workingStates.update(sessionId, STATE_WITH_ONE_TODO);

    fx.setNow(writtenAt + 4 * MINUTE_MS);
    const at4Minutes = await stop();
    fx.setNow(writtenAt + 6 * MINUTE_MS);
    const at6Minutes = await stop();

    expect(at4Minutes).toEqual({});
    expect(at6Minutes.decision).toBe('block');
  });
});

describe('user can see a refused turn continue instead of ending', () => {
  it('keeps the session generating during a refusal, types the queued message only after the accepted Stop', async () => {
    await postHook({ hook_event_name: 'SessionStart' });
    await promptSubmitted();
    fx.sessions.sendMessage({ sessionId, body: 'next task please' });

    const refused = await stop();
    const stateDuringRefusal = stateOfSession();
    const typedDuringRefusal = typedBodies().some((written) => written.includes('next task please'));
    const accepted = await stop({ stop_hook_active: true });

    expect(refused.decision).toBe('block');
    expect(stateDuringRefusal).toBe('generating');
    expect(typedDuringRefusal).toBe(false);
    expect(accepted).toEqual({});
    await vi.waitFor(() => expect(typedBodies().some((written) => written.includes('next task please'))).toBe(true));
  });

  it('keeps a model switch requested during the turn waiting through the refusal, and relaunches after the accepted Stop', async () => {
    await postHook({ hook_event_name: 'SessionStart' });
    await promptSubmitted();
    const launchesBefore = fx.harness.launches.length;
    expect(fx.sessions.updateModel(sessionId, 'claude-opus-5-5').status).toBe('deferred');

    await stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const launchesDuringRefusal = fx.harness.launches.length;
    await stop({ stop_hook_active: true });

    expect(launchesDuringRefusal).toBe(launchesBefore);
    await vi.waitFor(() => expect(fx.harness.launches.length).toBe(launchesBefore + 1));
  });

  it('keeps a model switch waiting through a refusal of a turn whose start the daemon never saw', async () => {
    await postHook({ hook_event_name: 'SessionStart' });
    fx.sessions.sendMessage({ sessionId, body: 'typed by the daemon' });
    await vi.waitFor(() => expect(typedBodies()).toContain('\r'));
    const launchesBefore = fx.harness.launches.length;
    expect(fx.sessions.updateModel(sessionId, 'claude-opus-5-5').status).toBe('deferred');

    await stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const launchesDuringRefusal = fx.harness.launches.length;
    await stop({ stop_hook_active: true });

    expect(launchesDuringRefusal).toBe(launchesBefore);
    await vi.waitFor(() => expect(fx.harness.launches.length).toBe(launchesBefore + 1));
  });
});

describe('user can rely on a failing refusal check never trapping a session in generating', () => {
  it('lets the turn end, applies the Stop and logs a warning when the refusal decision throws', async () => {
    await fx.server.close();
    const throwingRefusal = { decide: () => { throw new Error('corrupt sections_json'); } } as unknown as StopRefusal;
    fx = await startFixture({}, throwingRefusal);
    const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
    sessionId = session.id;
    hookToken = hookTokenOf(session.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await postHook({ hook_event_name: 'SessionStart' });
    await promptSubmitted();
    const stateBeforeStop = stateOfSession();

    const answer = await stop();

    expect(stateBeforeStop).toBe('generating');
    expect(answer).toEqual({});
    expect(stateOfSession()).toBe('idle');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARN'));
    expect(warn.mock.calls.flat().join(' ')).toContain('corrupt sections_json');
    warn.mockRestore();
  });
});

describe('a session that was never enforced keeps the behaviour of today', () => {
  it('answers {} to every Stop when the daemon has no stop refusal wired', async () => {
    await fx.server.close();
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const managerRepo = new ManagerRepository(db);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
    const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
    const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus, timeoutMs: 100 }), managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
    const session = await sessions.create({ directory: '/tmp', name: 'Old', harness: 'fake', emoji: '🤖' });
    const token = (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(session.id) as { hook_token: string }).hook_token;

    const response = await fetch(`${server.url}/hooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'Stop' }) });

    expect(await response.json()).toEqual({});
    await server.close();
    fx = await startFixture();
  });
});
