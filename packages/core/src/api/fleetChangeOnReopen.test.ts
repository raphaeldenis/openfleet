import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import type { ServerEvent, WorkingStateSections } from '@openfleet/shared';
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
import { SessionStartContext } from '../workingState/sessionStartContext.js';
import { StopRefusal } from '../workingState/stopRefusal.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import type { WorkingStateSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const STATE: WorkingStateSections = { plan: ['ship'], todo: ['write tests'], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] };
const FAIL_FAST_MS = 500;
const DISTINCT_CLOCK_TICK_MS = 5;

let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let workingStates: WorkingStateService;
let managerId: string;

async function startFixture() {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const settings: WorkingStateSettings = { maxBytes: 8192, enforce: true, maxAgeMinutes: 30 };
  const clock = () => new Date().toISOString();
  workingStates = new WorkingStateService({ db, clock, stateRoot: mkdtempSync(join(tmpdir(), 'of-reopen-mirror-')), maxBytes: settings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings, clock });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings, clock });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', workingStates, stopRefusal, sessionStartContext });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, DISTINCT_CLOCK_TICK_MS));
const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const postHook = async (sessionId: string, body: Record<string, unknown>) => {
  const response = await fetch(`${server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<{ decision?: string; reason?: string; hookSpecificOutput?: { additionalContext: string } }>;
};
const stopOf = (sessionId: string) => postHook(sessionId, { hook_event_name: 'Stop' });
const clearedSessionStartOf = (sessionId: string) => postHook(sessionId, { hook_event_name: 'SessionStart', source: 'clear' });
const spawnChild = (name: string, parentId = managerId) => sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🧒', parentId });
const reopen = (sessionId: string) => api(`/api/sessions/${sessionId}/reopen`, { method: 'POST' });
const fleetChangedAtOf = async (id: string) => ((await (await api(`/api/sessions/${id}/working-state`)).json()) as { fleetChangedAt?: string }).fleetChangedAt;
const listedSession = async (id: string) => ((await (await api('/api/sessions')).json()) as { id: string; closedAt?: string; state: string }[]).find((session) => session.id === id)!;
const reopenRowCountOf = (id: string) => (db.prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND kind = 'reopened'").get(id) as { count: number }).count;
class FailingHarness implements Harness {
  readonly id = 'fake' as const;
  start(_launch: HarnessLaunch): HarnessHandle { throw new Error('pty spawn ENOENT'); }
}
const makeEveryLaunchFail = () => { (sessions as unknown as { harnessFor: (id: string) => Harness }).harnessFor = () => new FailingHarness(); };
const childReachesIdle = (childId: string) => postHook(childId, { hook_event_name: 'SessionStart', source: 'startup' });

const closeChildThenWriteManagerStateThenReopen = async (childId: string) => {
  await tick();
  await sessions.close(childId);
  await tick();
  workingStates.update(managerId, STATE);
  await tick();
  return reopen(childId);
};

const failFast = <T>(promise: Promise<T>, expectation: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${FAIL_FAST_MS} ms: ${expectation}`)), FAIL_FAST_MS))]);

interface Connection { ws: WebSocket; received: ServerEvent[] }
async function connect(): Promise<Connection> {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  const received: ServerEvent[] = [];
  const firstFrame = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve(), { once: true }));
  ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
  await firstFrame;
  received.shift();
  return { ws, received };
}

// Events reach a client in order: once the marker rename has arrived, everything emitted before it has too.
async function workingStateEventsAfterSettling(connection: Connection, markerSessionId: string) {
  const marker = new Promise<void>((resolve) => connection.ws.addEventListener('message', (message) => { if (JSON.parse(String(message.data)).type === 'session.updated') resolve(); }));
  sessions.rename(markerSessionId, { name: 'marker' });
  await failFast(marker, 'the settle marker never reached the client');
  return connection.received.filter((event): event is Extract<ServerEvent, { type: 'session.working_state' }> => event.type === 'session.working_state');
}

beforeEach(async () => {
  await startFixture();
  managerId = (await sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' })).id;
});
afterEach(() => server.close());

describe('user can rely on a reopened child making its manager state stale', () => {
  it('refuses the turn end of a manager whose state says a child is closed once that child is reopened, naming it as reopened', async () => {
    const child = await spawnChild('Builder-3');
    await closeChildThenWriteManagerStateThenReopen(child.id);

    const refused = await stopOf(managerId);
    await tick();
    workingStates.update(managerId, STATE);
    const accepted = await stopOf(managerId);

    expect(refused.decision).toBe('block');
    expect(refused.reason).toContain('Builder-3 (reopened)');
    expect(accepted).toEqual({});
  });

  it('marks the state stale on the first line of the SessionStart answer of a manager whose child was reopened', async () => {
    const child = await spawnChild('Builder-3');
    await closeChildThenWriteManagerStateThenReopen(child.id);

    const answer = await clearedSessionStartOf(managerId);

    expect(answer.hookSpecificOutput!.additionalContext.split('\n')[0]).toContain('stale');
  });

  it('keeps the state stale after the reopened child reaches idle and its closed time is cleared', async () => {
    const child = await spawnChild('Builder-3');
    await closeChildThenWriteManagerStateThenReopen(child.id);

    await childReachesIdle(child.id);
    const refused = await stopOf(managerId);

    expect((await listedSession(child.id)).closedAt).toBeUndefined();
    expect(refused.decision).toBe('block');
    expect(refused.reason).toContain('Builder-3 (reopened)');
  });

  it('does not stale a manager whose child is reopened on a daemon boot', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    workingStates.update(managerId, STATE);
    await tick();
    const restartedDaemon = new SessionService({ db, bus: new EventBus(), harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });

    await restartedDaemon.resumeAll();

    expect(restartedDaemon.get(child.id)!.state).not.toBe('closed');
    expect(await stopOf(managerId)).toEqual({});
  });
});

describe('user can see the fleet change of a reopen on the state of the manager', () => {
  it('sends one working state of the manager on a reopen, carrying the reopen time, and keeps that value once the child is idle', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    workingStates.update(managerId, STATE);
    const connection = await connect();
    await tick();

    const beforeReopen = new Date().toISOString();
    await reopen(child.id);
    const afterReopen = new Date().toISOString();
    const eventsOfManager = (await workingStateEventsAfterSettling(connection, managerId)).filter((event) => event.state.sessionId === managerId);
    await childReachesIdle(child.id);
    const afterIdle = await fleetChangedAtOf(managerId);
    connection.ws.close();

    expect(eventsOfManager).toHaveLength(1);
    const fleetChangedAtInEvent = eventsOfManager[0]!.state.fleetChangedAt!;
    expect(fleetChangedAtInEvent >= beforeReopen && fleetChangedAtInEvent <= afterReopen).toBe(true);
    expect(afterIdle).toBe(fleetChangedAtInEvent);
  });

  it('shows the second reopen as the fleet change when a child is reopened twice', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    workingStates.update(managerId, STATE);
    await tick();
    await reopen(child.id);
    await childReachesIdle(child.id);
    await tick();
    await sessions.close(child.id);
    await tick();

    const beforeSecondReopen = new Date().toISOString();
    await reopen(child.id);
    const fleetChangedAt = await fleetChangedAtOf(managerId);

    expect(fleetChangedAt! >= beforeSecondReopen).toBe(true);
  });

  it('never shows a fleet change older than the previous one across a close, a reopen and a second close', async () => {
    const child = await spawnChild('Builder-3');
    workingStates.update(managerId, STATE);
    await tick();
    await sessions.close(child.id);
    const afterFirstClose = await fleetChangedAtOf(managerId);
    await tick();
    await reopen(child.id);
    await childReachesIdle(child.id);
    const afterReopenAndIdle = await fleetChangedAtOf(managerId);
    await tick();
    await sessions.close(child.id);
    const afterSecondClose = await fleetChangedAtOf(managerId);

    expect(afterReopenAndIdle! >= afterFirstClose!).toBe(true);
    expect(afterSecondClose! >= afterReopenAndIdle!).toBe(true);
  });

  it('leaves the manager state fresh and the child closed with its old closed time when a reopen fails to launch', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    const closedAtBeforeFailure = (await listedSession(child.id)).closedAt;
    await tick();
    workingStates.update(managerId, STATE);
    await tick();
    makeEveryLaunchFail();

    const failedReopen = await reopen(child.id);

    expect(failedReopen.status).toBe(500);
    expect((await listedSession(child.id)).state).toBe('closed');
    expect((await listedSession(child.id)).closedAt).toBe(closedAtBeforeFailure);
    expect(reopenRowCountOf(child.id)).toBe(0);
    expect(await stopOf(managerId)).toEqual({});
  });

  it('keeps the reopen row of a successful reopen', async () => {
    const child = await spawnChild('Builder-3');
    await closeChildThenWriteManagerStateThenReopen(child.id);

    expect(reopenRowCountOf(child.id)).toBe(1);
    expect((await stopOf(managerId)).decision).toBe('block');
  });

  it('keeps the reopen row of an earlier successful reopen when a later reopen of the same child fails', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    await tick();
    await reopen(child.id);
    await childReachesIdle(child.id);
    await tick();
    await sessions.close(child.id);
    await tick();
    makeEveryLaunchFail();

    await reopen(child.id);

    expect(reopenRowCountOf(child.id)).toBe(1);
  });

  it('does not stale a manager when a child of another manager is reopened', async () => {
    const otherManager = await sessions.create({ directory: '/tmp', name: 'Other', harness: 'fake', emoji: '🤖' });
    const foreignChild = await spawnChild('Foreign', otherManager.id);
    await tick();
    await sessions.close(foreignChild.id);
    await tick();
    workingStates.update(managerId, STATE);
    await tick();

    await reopen(foreignChild.id);

    expect(await stopOf(managerId)).toEqual({});
    expect(await fleetChangedAtOf(managerId)).toBeUndefined();
  });

  it('does not stale a grandparent when a grandchild is reopened', async () => {
    const child = await spawnChild('Child');
    const grandchild = await spawnChild('Grandchild', child.id);
    await tick();
    await sessions.close(grandchild.id);
    await tick();
    workingStates.update(managerId, STATE);
    await tick();

    await reopen(grandchild.id);

    expect(await stopOf(managerId)).toEqual({});
  });

  it('sends no working state of a closed manager when its child is reopened', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    workingStates.update(managerId, STATE);
    await sessions.close(managerId);
    const connection = await connect();

    await reopen(child.id);
    const events = await workingStateEventsAfterSettling(connection, child.id);
    connection.ws.close();

    expect(events.filter((event) => event.state.sessionId === managerId)).toHaveLength(0);
  });
});
