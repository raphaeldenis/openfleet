import { randomUUID } from 'node:crypto';
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
import { startServer } from './server.js';

const CLEAR_IN_FLIGHT_TIMEOUT_MS = 400;
const CLEAR_FLUSH_GRACE_MS = 300;

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;

const bootDaemon = async (holds: { clearInFlightTimeoutMs: number; clearFlushGraceMs: number }) => {
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  const bus = new EventBus();
  const sessions = new SessionService({
    db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0, ...holds,
  });
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

    expect(oldHandle.killed).toBe(false);
    await expect.poll(() => oldHandle.killed).toBe(true);
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
