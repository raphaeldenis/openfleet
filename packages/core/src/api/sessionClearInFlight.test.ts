import { randomUUID } from 'node:crypto';
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
import { startServer } from './server.js';

const CLEAR_IN_FLIGHT_TIMEOUT_MS = 400;
const CLEAR_FLUSH_GRACE_MS = 300;

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;

let service: SessionService;

const bootDaemon = async (holds: { clearInFlightTimeoutMs?: number; clearFlushGraceMs?: number }) => {
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  const bus = new EventBus();
  const sessions = new SessionService({
    db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0, ...holds,
  });
  service = sessions;
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
};

beforeEach(async () => {
  await bootDaemon({ clearInFlightTimeoutMs: CLEAR_IN_FLIGHT_TIMEOUT_MS, clearFlushGraceMs: CLEAR_FLUSH_GRACE_MS });
});

afterEach(async () => {
  vi.useRealTimers();
  await server.close();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });

const postJson = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

const transcriptPathOf = (cliSessionId: string) => `/tmp/of-transcripts/${cliSessionId}.jsonl`;

const sendHook = async (id: string, event: Record<string, unknown>, cliSessionId: string = id) => {
  const { hookToken } = (await (await api(`/api/sessions/${id}/tokens`)).json()) as { hookToken: string };
  return fetch(`${server.url}/hooks/${hookToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: cliSessionId, transcript_path: transcriptPathOf(cliSessionId), ...event }),
  });
};

const runningSession = async () => {
  const id = ((await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model: 'opus' })).json()) as { id: string }).id;
  await sendHook(id, { hook_event_name: 'SessionStart' });
  return id;
};

const sessionEndByClear = (id: string) => sendHook(id, { hook_event_name: 'SessionEnd', reason: 'clear' });
const sessionStartByClear = (id: string, clearedId: string) => sendHook(id, { hook_event_name: 'SessionStart', source: 'clear' }, clearedId);

const switchModel = async (id: string) => ((await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' })).json()) as Promise<{ status: string }>;
const changePermissionMode = async (id: string) => ((await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' })).json()) as Promise<{ status: string }>;

const lastLaunch = () => harness.launches.at(-1)!;

describe('a user whose model switch lands between the SessionEnd and the SessionStart of a /clear', () => {
  it('sees the switch deferred, then relaunched on the cleared conversation once the new conversation starts', async () => {
    const id = await runningSession();
    const clearedId = randomUUID();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);

    const answer = await switchModel(id);
    await sessionStartByClear(id, clearedId);

    expect(answer.status).toBe('deferred');
    expect(harness.launches).toHaveLength(launchesBefore);
    await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
    expect(lastLaunch().cliSessionId).toBe(clearedId);
    expect(lastLaunch().resuming).toBe(true);
  });

  it('sees a permission-mode change landing in the same window relaunched on the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = randomUUID();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);

    const answer = await changePermissionMode(id);
    await sessionStartByClear(id, clearedId);

    expect(answer.status).toBe('deferred');
    await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });

  it('sees the relaunch wait for the new conversation to be flushed before the old process is killed', async () => {
    const id = await runningSession();
    const oldHandle = harness.handles.at(-1)!;
    await sessionEndByClear(id);
    await switchModel(id);

    await sessionStartByClear(id, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, CLEAR_FLUSH_GRACE_MS / 2));

    expect(oldHandle.killed).toBe(false);
    await expect.poll(() => oldHandle.killed).toBe(true);
  });

  it('sees the relaunch stay held when another hook lets the session look idle inside the window', async () => {
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);
    await switchModel(id);

    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    await sendHook(id, { hook_event_name: 'Stop' });

    expect(harness.launches).toHaveLength(launchesBefore);
    await expect.poll(() => harness.launches.length, { timeout: 3000 }).toBe(launchesBefore + 1);
  });

  it('sees the relaunch go ahead on the current conversation when the new conversation never starts', async () => {
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);

    await switchModel(id);

    expect(harness.launches).toHaveLength(launchesBefore);
    await expect.poll(() => harness.launches.length, { timeout: 3000 }).toBe(launchesBefore + 1);
    expect(lastLaunch().cliSessionId).toBe(id);
  });
});

describe('a user switching the model with no /clear in flight', () => {
  it('sees the session relaunch right away, even when the clear holds last a minute', async () => {
    await server.close();
    await bootDaemon({ clearInFlightTimeoutMs: 60_000, clearFlushGraceMs: 60_000 });
    const id = await runningSession();
    const launchesBefore = harness.launches.length;

    const answer = await switchModel(id);

    expect(answer.status).toBe('relaunching');
    await expect.poll(() => harness.launches.length, { timeout: 1000, interval: 10 }).toBe(launchesBefore + 1);
  });

  it('sees a session whose /clear finished long ago relaunch right away', async () => {
    const id = await runningSession();
    const clearedId = randomUUID();
    await sessionEndByClear(id);
    await sessionStartByClear(id, clearedId);
    await new Promise((resolve) => setTimeout(resolve, CLEAR_FLUSH_GRACE_MS + 100));
    const launchesBefore = harness.launches.length;

    const answer = await switchModel(id);

    expect(answer.status).toBe('relaunching');
    await expect.poll(() => harness.launches.length, { timeout: 200, interval: 10 }).toBe(launchesBefore + 1);
    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });
});

const rebootOnFakeClock = async (holds: { clearInFlightTimeoutMs?: number; clearFlushGraceMs?: number }) => {
  await server.close();
  await bootDaemon(holds);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('a user whose daemon runs with the default /clear holds', () => {
  it('sees a model switch made after a SessionEnd wait 3000 ms, not a millisecond less, before it relaunches', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);

    const answer = await switchModel(id);
    await advance(2999);
    const launchesJustBeforeTheTimeout = harness.launches.length;
    await advance(1);

    expect(answer.status).toBe('deferred');
    expect(launchesJustBeforeTheTimeout).toBe(launchesBefore);
    expect(harness.launches).toHaveLength(launchesBefore + 1);
  });

  it('sees the old process kept 500 ms, not a millisecond less, after the new conversation starts', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const oldHandle = harness.handles.at(-1)!;
    await sessionEndByClear(id);
    await switchModel(id);
    await sessionStartByClear(id, randomUUID());

    await advance(499);
    const isKilledJustBeforeTheGrace = oldHandle.killed;
    await advance(1);

    expect(isKilledJustBeforeTheGrace).toBe(false);
    expect(oldHandle.killed).toBe(true);
  });
});

describe('a user closing a session inside the flush grace of a /clear', () => {
  it('sees the process kept alive until the grace has ended, not a millisecond less', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const handle = harness.handles.at(-1)!;
    await sessionEndByClear(id);
    await sessionStartByClear(id, randomUUID());

    const userClose = service.close(id);
    await advance(299);
    const isKilledJustBeforeTheGrace = handle.killed;
    await advance(1);
    await userClose;

    expect(isKilledJustBeforeTheGrace).toBe(false);
    expect(handle.killed).toBe(true);
    expect(service.get(id)?.state).toBe('closed');
  });

  it('sees a close made before the SessionStart of the /clear kill at once, since no flush is under way', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const handle = harness.handles.at(-1)!;
    await sessionEndByClear(id);

    const userClose = service.close(id);
    await advance(1);
    await userClose;

    expect(handle.killed).toBe(true);
  });
});

describe('a user whose SessionStart of a /clear arrives before its SessionEnd', () => {
  it('sees a model switch relaunch after the flush grace, not after the full wait for a SessionStart that already came', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionStartByClear(id, randomUUID());
    await sessionEndByClear(id);

    const answer = await switchModel(id);
    await advance(499);
    const launchesJustBeforeTheGrace = harness.launches.length;
    await advance(1);

    expect(answer.status).toBe('deferred');
    expect(launchesJustBeforeTheGrace).toBe(launchesBefore);
    expect(harness.launches).toHaveLength(launchesBefore + 1);
  });

  it('sees the process kept for the flush grace of that SessionStart when a switch is pending', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const oldHandle = harness.handles.at(-1)!;
    await sessionStartByClear(id, randomUUID());
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(499);
    const isKilledJustBeforeTheGrace = oldHandle.killed;
    await advance(1);

    expect(isKilledJustBeforeTheGrace).toBe(false);
    expect(oldHandle.killed).toBe(true);
  });
});

describe('a user clearing twice in a row', () => {
  it('sees the second /clear restart the wait, so a switch made after the first wait would have ended is still deferred', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);
    await advance(300);
    await sessionEndByClear(id);
    await advance(400);

    const answer = await switchModel(id);

    expect(answer.status).toBe('deferred');
    expect(harness.launches).toHaveLength(launchesBefore);
  });
});

describe('a user whose new conversations keep starting during the flush grace', () => {
  it('sees the pending relaunch go ahead when the first grace ends, however many SessionStart keep arriving', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);
    await switchModel(id);

    await sessionStartByClear(id, randomUUID());
    await advance(100);
    await sessionStartByClear(id, randomUUID());
    await advance(100);
    await sessionStartByClear(id, randomUUID());
    await advance(100);

    expect(harness.launches).toHaveLength(launchesBefore + 1);
  });
});

describe('a daemon shutting down while a /clear is in flight', () => {
  it('finishes shutting down once the flush grace of a session that a user closes meanwhile has ended', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 60_000, clearFlushGraceMs: 300 });
    const id = await runningSession();
    await sessionEndByClear(id);
    await sessionStartByClear(id, randomUUID());
    let isShutdownFinished = false;
    const shutdown = service.closeAll().then(() => { isShutdownFinished = true; });
    const userClose = service.close(id);

    await advance(299);
    const isFinishedJustBeforeTheGrace = isShutdownFinished;
    await advance(1);

    expect(isFinishedJustBeforeTheGrace).toBe(false);
    expect(isShutdownFinished).toBe(true);
    await Promise.all([shutdown, userClose]);
  });

  it('waits at most the flush grace for every session, whatever the longer holds of the others', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 60_000, clearFlushGraceMs: 300 });
    const flushing = await runningSession();
    const waitingForItsSessionStart = await runningSession();
    await sessionEndByClear(flushing);
    await sessionStartByClear(flushing, randomUUID());
    await sessionEndByClear(waitingForItsSessionStart);
    let isShutdownFinished = false;
    const shutdown = service.closeAll().then(() => { isShutdownFinished = true; });

    await advance(299);
    const isFinishedJustBeforeTheGrace = isShutdownFinished;
    await advance(1);

    expect(isFinishedJustBeforeTheGrace).toBe(false);
    expect(isShutdownFinished).toBe(true);
    await shutdown;
  });
});
