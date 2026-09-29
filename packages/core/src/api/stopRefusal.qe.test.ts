import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkingStateSections } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { renderWorkingState } from '../workingState/renderWorkingState.js';
import { StopRefusal } from '../workingState/stopRefusal.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import type { WorkingStateSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const MINUTE_MS = 60_000;
const STATE: WorkingStateSections = { plan: ['ship'], todo: ['write tests'], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] };

interface Fixture { server: Awaited<ReturnType<typeof startServer>>; db: DatabaseSync; sessions: SessionService; workingStates: WorkingStateService; setNow: (ms: number) => void; now: () => number }
let fx: Fixture;
let sessionId: string;
let hookToken: string;

async function startFixture(settings: Partial<WorkingStateSettings> = {}): Promise<Fixture> {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  let nowMs = Date.now();
  const clock = () => new Date(nowMs).toISOString();
  const workingStateSettings: WorkingStateSettings = { maxBytes: 6144, enforce: true, maxAgeMinutes: 30, ...settings };
  const workingStates = new WorkingStateService({ db, clock, stateRoot: mkdtempSync(join(tmpdir(), 'of-stop-qe-')), maxBytes: workingStateSettings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings: workingStateSettings, clock });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', stopRefusal });
  return { server, db, sessions, workingStates, setNow: (ms) => { nowMs = ms; }, now: () => nowMs };
}

const tokenOf = (id: string) => (fx.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const post = async (body: Record<string, unknown>, token = hookToken) => {
  const response = await fetch(`${fx.server.url}/hooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<{ decision?: string; reason?: string }>;
};
const stop = (extra: Record<string, unknown> = {}) => post({ hook_event_name: 'Stop', ...extra });
const stateOfSession = (id = sessionId) => fx.sessions.list().find((session) => session.id === id)!.state;
const restart = async (settings: Partial<WorkingStateSettings>) => {
  await fx.server.close();
  fx = await startFixture(settings);
  const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
  sessionId = session.id;
  hookToken = tokenOf(session.id);
};
const isoAt = (ms: number) => new Date(ms).toISOString();
const insertRawState = (sections: WorkingStateSections, updatedAt: string, id = sessionId) =>
  fx.db.prepare('INSERT OR REPLACE INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(id, JSON.stringify(sections), updatedAt);

beforeEach(async () => {
  fx = await startFixture();
  const session = await fx.sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' });
  sessionId = session.id;
  hookToken = tokenOf(session.id);
});
afterEach(() => fx.server.close());

describe('QE boundaries of the turn end refusal', () => {
  it('lets a state exactly maxAgeMinutes old end the turn and refuses one millisecond older', async () => {
    const writtenAt = fx.now();
    insertRawState(STATE, isoAt(writtenAt));

    fx.setNow(writtenAt + 30 * MINUTE_MS);
    const exactly30 = await stop();
    fx.setNow(writtenAt + 30 * MINUTE_MS + 1);
    const justOver = await stop();

    expect(exactly30).toEqual({});
    expect(justOver.decision).toBe('block');
  });

  it('reports the age floored to whole minutes', async () => {
    const writtenAt = fx.now();
    insertRawState(STATE, isoAt(writtenAt));
    fx.setNow(writtenAt + 31 * MINUTE_MS + 59_999);
    expect((await stop()).reason).toContain('31 minutes old');
  });

  it('lets a state written the same millisecond as the last child spawn end the turn, and refuses one written 1 ms before', async () => {
    const child = await fx.sessions.create({ directory: '/tmp', name: 'Kid', harness: 'fake', emoji: '🧒', parentId: sessionId });
    const spawnedAtIso = (fx.db.prepare('SELECT created_at FROM sessions WHERE id = ?').get(child.id) as { created_at: string }).created_at;
    const spawnedAt = Date.parse(spawnedAtIso);
    fx.setNow(spawnedAt + 1000);

    insertRawState(STATE, spawnedAtIso);
    const sameMillisecond = await stop();
    insertRawState(STATE, isoAt(spawnedAt - 1));
    const oneMillisecondBefore = await stop();

    expect(sameMillisecond).toEqual({});
    expect(oneMillisecondBefore.decision).toBe('block');
  });

  it('lets a state of exactly maxBytes end the turn and refuses one byte more', async () => {
    await restart({ maxBytes: 1024 });
    const base = renderWorkingState({ ...STATE, todo: [''] });
    const stateOfSize = (bytes: number): WorkingStateSections => ({ ...STATE, todo: ['x'.repeat(bytes - Buffer.byteLength(renderWorkingState({ ...STATE, todo: ['x'] }), 'utf8') + 1)] });
    expect(base.length).toBeGreaterThan(0);
    const at1024 = stateOfSize(1024);
    const at1025 = stateOfSize(1025);
    expect(Buffer.byteLength(renderWorkingState(at1024), 'utf8')).toBe(1024);
    expect(Buffer.byteLength(renderWorkingState(at1025), 'utf8')).toBe(1025);

    insertRawState(at1024, isoAt(fx.now()));
    const exact = await stop();
    insertRawState(at1025, isoAt(fx.now()));
    const oneOver = await stop();

    expect(exact).toEqual({});
    expect(oneOver.decision).toBe('block');
    expect(oneOver.reason).toContain('1025 bytes');
  });

  it('names 10 children without a "more" suffix and 11 with "and 1 more"', async () => {
    insertRawState(STATE, isoAt(fx.now() - 5 * MINUTE_MS));
    for (let index = 1; index <= 10; index++) await fx.sessions.create({ directory: '/tmp', name: `K-${String(index).padStart(2, '0')}`, harness: 'fake', emoji: '🧒', parentId: sessionId });
    const with10 = await stop();
    await fx.sessions.create({ directory: '/tmp', name: 'K-11', harness: 'fake', emoji: '🧒', parentId: sessionId });
    const with11 = await stop();

    expect(with10.reason).not.toContain('more');
    expect(with10.reason!.match(/K-\d\d/g)).toHaveLength(10);
    expect(with11.reason).toContain('and 1 more');
    expect(with11.reason!.match(/K-\d\d/g)).toHaveLength(10);
  });

  it('lists the fleet changes chronologically, not alphabetically, a child that was spawned then closed appearing twice', async () => {
    const writtenAt = fx.now() - 10 * MINUTE_MS;
    insertRawState(STATE, isoAt(writtenAt));
    const spawnedNames = ['Zed', 'Amy', 'Mid'];
    for (const [index, name] of spawnedNames.entries()) {
      const child = await fx.sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🧒', parentId: sessionId });
      fx.db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(isoAt(writtenAt + (index + 1) * 1000), child.id);
    }
    const answer = await stop();

    expect(answer.reason).toContain('Zed (spawned), Amy (spawned), Mid (spawned)');
  });

  it('gives the size, the cap and the log advice in the oversize reason, and the age and limit in the stale reason', async () => {
    await restart({ maxBytes: 1024, maxAgeMinutes: 7 });
    insertRawState({ ...STATE, todo: ['y'.repeat(2000)] }, isoAt(fx.now()));
    const oversize = await stop();
    insertRawState(STATE, isoAt(fx.now() - 9 * MINUTE_MS));
    const old = await stop();

    expect(oversize.reason).toMatch(/is \d+ bytes, the cap is 1024/);
    expect(oversize.reason).toContain('keep the current state only, move history to the log');
    expect(oversize.reason).toContain('update_working_state');
    expect(old.reason).toContain('9 minutes old (the limit is 7)');
  });

  it('checks age before fleet before size: a state that is old, fleet-stale and oversize reports the age', async () => {
    await restart({ maxBytes: 1024 });
    insertRawState({ ...STATE, todo: ['y'.repeat(2000)] }, isoAt(fx.now() - 60 * MINUTE_MS));
    await fx.sessions.create({ directory: '/tmp', name: 'Kid', harness: 'fake', emoji: '🧒', parentId: sessionId });
    expect((await stop()).reason).toContain('minutes old');
  });

  it('checks fleet before size when the state is young but stale and oversize', async () => {
    await restart({ maxBytes: 1024 });
    insertRawState({ ...STATE, todo: ['y'.repeat(2000)] }, isoAt(fx.now() - 5 * MINUTE_MS));
    await fx.sessions.create({ directory: '/tmp', name: 'Kid', harness: 'fake', emoji: '🧒', parentId: sessionId });
    expect((await stop()).reason).toContain('fleet changed');
  });

  it('measures the size in bytes: 400 accented characters over the cap count double', async () => {
    await restart({ maxBytes: 1024 });
    insertRawState({ ...STATE, todo: ['é'.repeat(300), 'é'.repeat(300)] }, isoAt(fx.now()));
    expect((await stop()).decision).toBe('block');
  });
});

describe('QE loop guard with a hostile stop_hook_active', () => {
  it('lets the turn end when stop_hook_active is true, and refuses when it is false or absent', async () => {
    expect((await stop({ stop_hook_active: true })).decision).toBeUndefined();
    expect((await stop({ stop_hook_active: false })).decision).toBe('block');
    expect((await stop()).decision).toBe('block');
  });

  it.each([['the string "true"', 'true'], ['the number 1', 1], ['null', null], ['an object', {}]])('never blocks a Stop whose stop_hook_active is %s, and does not move the session', async (_label, hostile) => {
    await post({ hook_event_name: 'UserPromptSubmit' });
    const answer = await stop({ stop_hook_active: hostile });
    expect(answer).toEqual({});
    expect(stateOfSession()).toBe('generating');
  });
});

describe('QE hostile sessions', () => {
  it('answers {} for an unknown hook token', async () => {
    expect(await post({ hook_event_name: 'Stop' }, 'no-such-token')).toEqual({});
  });

  it('answers {} to the Stop of a closed session', async () => {
    await fx.sessions.close(sessionId);
    expect(await stop()).toEqual({});
  });

  it('refuses a child session with no state like any other, and a manager with no state that already has children', async () => {
    const child = await fx.sessions.create({ directory: '/tmp', name: 'Kid', harness: 'fake', emoji: '🧒', parentId: sessionId });
    const childAnswer = await post({ hook_event_name: 'Stop' }, tokenOf(child.id));
    const managerAnswer = await stop();

    expect(childAnswer.decision).toBe('block');
    expect(childAnswer.reason).toContain('No working state is recorded');
    expect(managerAnswer.decision).toBe('block');
    expect(managerAnswer.reason).toContain('No working state is recorded');
  });

  it('refuses each of two replayed Stops of one turn (none carries stop_hook_active) and keeps the session generating', async () => {
    await post({ hook_event_name: 'UserPromptSubmit' });
    const first = await stop();
    const replay = await stop();
    expect([first.decision, replay.decision]).toEqual(['block', 'block']);
    expect(stateOfSession()).toBe('generating');
  });

  it('answers two concurrent Stops identically', async () => {
    await post({ hook_event_name: 'UserPromptSubmit' });
    const answers = await Promise.all([stop(), stop(), stop({ stop_hook_active: true })]);
    expect(answers.map((answer) => answer.decision)).toEqual(['block', 'block', undefined]);
  });

  it('a clock that goes backwards makes the state look young, never refused for age', async () => {
    const writtenAt = fx.now();
    insertRawState(STATE, isoAt(writtenAt));
    fx.setNow(writtenAt - 120 * MINUTE_MS);
    expect(await stop()).toEqual({});
  });

  it.each(['plan', 'manual', 'default', 'acceptEdits', 'bypassPermissions'])('decides the same in permission mode %s', async (permission_mode) => {
    await post({ hook_event_name: 'UserPromptSubmit' });
    const refused = await stop({ permission_mode });
    insertRawState(STATE, isoAt(fx.now()));
    const accepted = await stop({ permission_mode });
    expect(refused.decision).toBe('block');
    expect(accepted).toEqual({});
  });

  it('keeps the session generating on a refused Stop even when it was waiting_permission', async () => {
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'mcp__openfleet__update_working_state', tool_input: {} });
    await stop();
    expect(stateOfSession()).toBe('generating');
  });

  it('a Notification idle_prompt after a refused Stop still returns the session to idle', async () => {
    await post({ hook_event_name: 'UserPromptSubmit' });
    await stop();
    await post({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(stateOfSession()).toBe('idle');
  });

  it('a state row with an updated_at in an unparseable format never throws: the Stop still answers 200 JSON', async () => {
    insertRawState(STATE, 'garbage');
    const answer = await stop();
    expect(answer).toBeTypeOf('object');
  });
});
