import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@openfleet/shared';
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

const NEW_CONVERSATION_NOTICE = 'The previous conversation could not be found: started a new one.';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;
let service: SessionService;
let terminalOutput: string;

type Holds = { clearInFlightTimeoutMs?: number; clearFlushGraceMs?: number };

const bootDaemon = async (holds: Holds) => {
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  terminalOutput = '';
  const bus = new EventBus();
  bus.subscribe((event: ServerEvent) => {
    if (event.type === 'session.output') terminalOutput += event.data;
  });
  service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0, ...holds });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions: service, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions: service, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: service, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
};

const rebootOnFakeClock = async (holds: Holds, { fakesDate = false }: { fakesDate?: boolean } = {}) => {
  await server.close();
  await bootDaemon(holds);
  vi.useFakeTimers({ toFake: fakesDate ? ['setTimeout', 'clearTimeout', 'Date'] : ['setTimeout', 'clearTimeout'] });
};

beforeEach(async () => {
  await bootDaemon({ clearInFlightTimeoutMs: 50, clearFlushGraceMs: 0 });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await server.close();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const postJson = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

const sendHook = async (id: string, event: Record<string, unknown>, cliSessionId: string = id) => {
  const { hookToken } = (await (await api(`/api/sessions/${id}/tokens`)).json()) as { hookToken: string };
  return fetch(`${server.url}/hooks/${hookToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: cliSessionId, transcript_path: `/tmp/of-transcripts/${cliSessionId}.jsonl`, ...event }),
  });
};

const runningSession = async () => {
  const id = ((await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model: 'opus' })).json()) as { id: string }).id;
  await sendHook(id, { hook_event_name: 'SessionStart' });
  return id;
};

const sessionEndByClear = (id: string) => sendHook(id, { hook_event_name: 'SessionEnd', reason: 'clear' });
const sessionStartByClear = (id: string, clearedId: string = randomUUID()) => sendHook(id, { hook_event_name: 'SessionStart', source: 'clear' }, clearedId);
const switchModel = async (id: string) => ((await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' })).json()) as Promise<{ status: string }>;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const userPrompts = async (id: string, cliSessionId: string = id) => {
  harness.markPrompted(cliSessionId);
  await sendHook(id, { hook_event_name: 'UserPromptSubmit', user_prompt: 'hello' }, cliSessionId);
  await sendHook(id, { hook_event_name: 'Stop' }, cliSessionId);
};

const closeThenReopen = async (id: string) => {
  const launchesBefore = harness.launches.length;
  await postJson(`/api/sessions/${id}/close`);
  await postJson(`/api/sessions/${id}/reopen`);
  await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
};

const lastLaunch = () => harness.launches.at(-1)!;
const noticeCount = () => terminalOutput.split(NEW_CONVERSATION_NOTICE).length - 1;

describe('QE: a user clearing twice in a row, each /clear in the order SessionEnd then SessionStart', () => {
  it('sees a switch made after the second SessionEnd wait for the second SessionStart, not relaunch after the flush grace of the first', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionEndByClear(id);
    await sessionStartByClear(id);
    await advance(600);
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(1000);

    expect(harness.launches).toHaveLength(launchesBefore);
  });

  it('sees a second SessionEnd after a consumed SessionStart marker wait the full in-flight timeout, not a marker left over', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionStartByClear(id);
    await sessionEndByClear(id);
    await advance(600);
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(1000);

    expect(harness.launches).toHaveLength(launchesBefore);
  });
});

describe('QE: a user whose SessionStart of a /clear reaches the daemon first', () => {
  it('sees a close made in the grace that follows its SessionEnd wait for that grace', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const handle = harness.handles.at(-1)!;
    await sessionStartByClear(id);
    await sessionEndByClear(id);

    const userClose = service.close(id);
    await advance(299);
    const isKilledJustBeforeTheGrace = handle.killed;
    await advance(1);
    await userClose;

    expect(isKilledJustBeforeTheGrace).toBe(false);
    expect(handle.killed).toBe(true);
  });

  it('sees a SessionEnd exactly as late as the in-flight timeout still take the short grace', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 }, { fakesDate: true });
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionStartByClear(id);
    await advance(600);
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(300);

    expect(harness.launches).toHaveLength(launchesBefore + 1);
  });

  it('sees the SessionStart of another session not shorten the wait of this one', async () => {
    await rebootOnFakeClock({});
    const clearedElsewhere = await runningSession();
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionStartByClear(clearedElsewhere);
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(1000);

    expect(harness.launches).toHaveLength(launchesBefore);
  });

  it('sees two SessionStarts in a row followed by one SessionEnd still take the short grace once', async () => {
    await rebootOnFakeClock({});
    const id = await runningSession();
    const launchesBefore = harness.launches.length;
    await sessionStartByClear(id);
    await sessionStartByClear(id);
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(500);

    expect(harness.launches).toHaveLength(launchesBefore + 1);
  });
});

describe('QE: a user closing sessions while /clear graces run', () => {
  it('sees a session with no grace killed synchronously, before close() even yields', async () => {
    const id = await runningSession();
    const handle = harness.handles.at(-1)!;

    const userClose = service.close(id);
    const isKilledBeforeYielding = handle.killed;
    await userClose;

    expect(isKilledBeforeYielding).toBe(true);
  });

  it('sees a session closed at once while another session sits in its flush grace', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const inGrace = await runningSession();
    const other = await runningSession();
    const otherHandle = harness.handles.at(-1)!;
    const inGraceHandle = harness.handles.at(-2)!;
    await sessionEndByClear(inGrace);
    await sessionStartByClear(inGrace);

    const otherClose = service.close(other);
    const isOtherKilledAtOnce = otherHandle.killed;
    await otherClose;

    expect(isOtherKilledAtOnce).toBe(true);
    expect(inGraceHandle.killed).toBe(false);
    await advance(300);
  });

  it('sees a close and a daemon shutdown made together in a grace both finish, each session closed', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const handle = harness.handles.at(-1)!;
    const kill = vi.spyOn(handle, 'kill');
    await sessionEndByClear(id);
    await sessionStartByClear(id);

    const userClose = service.close(id);
    const shutdown = service.closeAll();
    await advance(300);
    await Promise.all([userClose, shutdown]);

    expect(service.get(id)?.state).toBe('closed');
    expect(kill.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('sees a close in a grace with a pending model switch end closed, with no process left running', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    await sessionEndByClear(id);
    await sessionStartByClear(id);
    await switchModel(id);

    const userClose = service.close(id);
    await advance(300);
    await advance(2000);
    await userClose;

    expect(service.get(id)?.state).toBe('closed');
    expect(harness.handles.filter((handle) => !handle.killed)).toEqual([]);
  });

  it('sees a session whose process dies inside the grace close without the close hanging or throwing', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    const handle = harness.handles.at(-1)!;
    await sessionEndByClear(id);
    await sessionStartByClear(id);

    const userClose = service.close(id);
    handle.emitExit(1);
    await advance(300);
    await userClose;

    expect(service.get(id)?.state).toBe('closed');
  });

  it('sees no timer left behind once the daemon shut down after a grace', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    await sessionEndByClear(id);
    await sessionStartByClear(id);
    const shutdown = service.closeAll();
    await advance(300);
    await shutdown;

    await advance(10_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sees a session closed between SessionStart(clear) and SessionEnd(clear) forget the marker: after a reopen a SessionEnd takes the full in-flight timeout', async () => {
    await rebootOnFakeClock({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 }, { fakesDate: true });
    const id = await runningSession();
    await sessionStartByClear(id);
    await service.close(id);
    await postJson(`/api/sessions/${id}/reopen`);
    const launchesAfterReopen = harness.launches.length;
    await sessionEndByClear(id);
    await switchModel(id);

    await advance(300);

    expect(harness.launches).toHaveLength(launchesAfterReopen);
  });
});

describe('QE: a user closing over HTTP while a flush grace runs', () => {
  it('sees /close answer 200 only after the grace, and a second /close of the closed session answer 200 at once', async () => {
    await server.close();
    await bootDaemon({ clearInFlightTimeoutMs: 600, clearFlushGraceMs: 300 });
    const id = await runningSession();
    await sessionEndByClear(id);
    await sessionStartByClear(id);

    const startedAt = Date.now();
    const first = await postJson(`/api/sessions/${id}/close`);
    const firstTookMs = Date.now() - startedAt;
    const secondStartedAt = Date.now();
    const second = await postJson(`/api/sessions/${id}/close`);
    const secondTookMs = Date.now() - secondStartedAt;

    expect(first.status).toBe(200);
    expect(firstTookMs).toBeGreaterThanOrEqual(250);
    expect(second.status).toBe(200);
    expect(secondTookMs).toBeLessThan(150);
  });
});

describe('QE: prompted flag under every transition', () => {
  it('sees a prompted conversation stay lost-worthy after a SessionStart(compact) and a SessionStart(resume) that name the same id', async () => {
    const id = await runningSession();
    await userPrompts(id);
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'compact' });
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'resume' });
    harness.missingConversations.add(id);

    await closeThenReopen(id);

    expect(lastLaunch().cliSessionId).not.toBe(id);
    expect(noticeCount()).toBe(1);
  });

  it('sees a prompted conversation stay lost-worthy after a model switch relaunch whose CLI reports a SessionStart(resume)', async () => {
    const id = await runningSession();
    await userPrompts(id);
    const launchesBefore = harness.launches.length;
    await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });
    await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'resume' });
    harness.missingConversations.add(id);

    await closeThenReopen(id);

    expect(noticeCount()).toBe(1);
  });

  it('sees a second prompt in the same conversation change nothing: still one notice when the file is lost', async () => {
    const id = await runningSession();
    await userPrompts(id);
    await userPrompts(id);
    harness.missingConversations.add(id);

    await closeThenReopen(id);

    expect(noticeCount()).toBe(1);
  });

  it('sees a prompted conversation of one session never make the unprompted one of another announce anything', async () => {
    const prompted = await runningSession();
    const unprompted = await runningSession();
    await userPrompts(prompted);
    harness.missingConversations.add(prompted);
    harness.missingConversations.add(unprompted);

    await closeThenReopen(prompted);
    const launchesAfterFirst = harness.launches.length;
    await closeThenReopen(unprompted);

    expect(noticeCount()).toBe(1);
    expect(harness.launches.length).toBe(launchesAfterFirst + 1);
    expect(lastLaunch().sessionId).toBe(unprompted);
    expect(lastLaunch().cliSessionId ?? lastLaunch().sessionId).toBe(unprompted);
  });

  it('sees a /clear, no prompt, a daemon restart and a reopen keep the same conversation id and say nothing', async () => {
    const id = await runningSession();
    const clearedId = randomUUID();
    await sessionEndByClear(id);
    await sessionStartByClear(id, clearedId);
    harness.missingConversations.add(clearedId);

    await closeThenReopen(id);
    await closeThenReopen(id);

    expect(lastLaunch().cliSessionId ?? lastLaunch().sessionId).toBe(clearedId);
    expect(noticeCount()).toBe(0);
  });
});
