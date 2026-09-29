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

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;

const bootDaemon = async () => {
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0, clearInFlightTimeoutMs: 50, clearFlushGraceMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
  return sessions;
};

const restartDaemon = async () => {
  await server.close();
  const restarted = await bootDaemon();
  await restarted.resumeAll();
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  await bootDaemon();
});

afterEach(async () => {
  await server.close();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });

const postJson = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

const transcriptPathOf = (cliSessionId: string) => `/tmp/of-transcripts/${cliSessionId}.jsonl`;

const createSession = async () => ((await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model: 'opus' })).json()) as { id: string }).id;

const sendHook = async (id: string, event: Record<string, unknown>, cliSessionId: string = id) => {
  const { hookToken } = (await (await api(`/api/sessions/${id}/tokens`)).json()) as { hookToken: string };
  return fetch(`${server.url}/hooks/${hookToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: cliSessionId, transcript_path: transcriptPathOf(cliSessionId), ...event }),
  });
};

const sessionStart = { hook_event_name: 'SessionStart' };
const sessionEndByClear = { hook_event_name: 'SessionEnd', reason: 'clear' };
const sessionStartByResume = { hook_event_name: 'SessionStart', source: 'resume' };
const sessionStartByClear = { hook_event_name: 'SessionStart', source: 'clear' };

const runningSession = async () => {
  const id = await createSession();
  await sendHook(id, sessionStart);
  return id;
};

const userTypesClear = async (id: string, newCliSessionId: string = randomUUID(), previousCliSessionId: string = id) => {
  await sendHook(id, sessionEndByClear, previousCliSessionId);
  await sendHook(id, sessionStartByClear, newCliSessionId);
  return newCliSessionId;
};

const lastLaunch = () => harness.launches.at(-1)!;

const switchModel = async (id: string) => {
  const launchesBefore = harness.launches.length;
  await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });
  await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
};

const changePermissionMode = async (id: string) => {
  const launchesBefore = harness.launches.length;
  await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' });
  await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
};

const closeThenReopen = async (id: string) => {
  const launchesBefore = harness.launches.length;
  await postJson(`/api/sessions/${id}/close`);
  await postJson(`/api/sessions/${id}/reopen`);
  await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
};

describe('a user relaunching a session after typing /clear', () => {
  it('sees a model switch relaunch the session on the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(clearedId);
    expect(lastLaunch().sessionId).toBe(id);
    expect(lastLaunch().resuming).toBe(true);
  });

  it('sees a permission-mode change relaunch the session on the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await changePermissionMode(id);

    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });

  it('sees a closed then reopened session resume the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await closeThenReopen(id);

    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });

  it('sees the cleared conversation resumed after a daemon restart', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await restartDaemon();

    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });

  it('sees a session cleared twice relaunch on the second cleared conversation', async () => {
    const id = await runningSession();
    const firstClearedId = await userTypesClear(id);
    const secondClearedId = await userTypesClear(id, randomUUID(), firstClearedId);

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(secondClearedId);
  });

  it('sees a session cleared, relaunched, then cleared again relaunch on the third conversation', async () => {
    const id = await runningSession();
    const firstClearedId = await userTypesClear(id);
    await switchModel(id);
    await sendHook(id, sessionStartByResume, firstClearedId);
    const secondClearedId = await userTypesClear(id, randomUUID(), firstClearedId);

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(secondClearedId);
  });

  it('sees a session that went back to its launch conversation with /resume relaunch on the launch conversation', async () => {
    const id = await runningSession();
    await userTypesClear(id);
    await sendHook(id, sessionStartByResume, id);

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(id);
  });

  it('sees a conversation picked with /resume in the raw terminal followed by the next relaunch', async () => {
    const id = await runningSession();
    const pickedId = randomUUID();
    await sendHook(id, sessionStartByResume, pickedId);

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(pickedId);
  });

  it('sees a session that was never cleared relaunch on its launch conversation', async () => {
    const id = await runningSession();

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(id);
  });

  it('sees a session whose SessionEnd with reason clear was not followed by a SessionStart relaunch on its launch conversation', async () => {
    const id = await runningSession();
    await sendHook(id, sessionEndByClear, randomUUID());

    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(id);
  });
});

describe('a session reporting a CLI session id that is not its own', () => {
  it("keeps resuming its own conversation when it reports another session's launch id", async () => {
    const neighbour = await runningSession();
    const id = await runningSession();

    await sendHook(id, sessionStartByClear, neighbour);
    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(id);
  });

  it("keeps resuming its own cleared conversation when it reports another session's cleared id, also after a daemon restart", async () => {
    const neighbour = await runningSession();
    const neighbourClearedId = await userTypesClear(neighbour);
    const id = await runningSession();
    const ownClearedId = await userTypesClear(id);

    await sendHook(id, sessionStartByClear, neighbourClearedId);
    await switchModel(id);
    const resumedBeforeRestart = lastLaunch().cliSessionId;
    await restartDaemon();
    await sendHook(id, sessionStartByClear, neighbourClearedId);
    await switchModel(id);
    const resumedAfterRestart = lastLaunch().cliSessionId;

    expect(resumedBeforeRestart).toBe(ownClearedId);
    expect(resumedAfterRestart).toBe(ownClearedId);
  });

  it('keeps its own conversation when it reports an id another session left behind after clearing twice', async () => {
    const owner = await runningSession();
    const thief = await runningSession();
    const leftBehindId = await userTypesClear(owner);
    await userTypesClear(owner, randomUUID(), leftBehindId);

    await sendHook(thief, sessionStartByClear, leftBehindId);
    await switchModel(thief);

    expect(lastLaunch().cliSessionId).toBe(thief);
  });

  it('keeps its own conversation when it reports an id another session left behind before a daemon restart', async () => {
    const owner = await runningSession();
    const thief = await runningSession();
    const leftBehindId = await userTypesClear(owner);
    await userTypesClear(owner, randomUUID(), leftBehindId);
    await restartDaemon();

    await sendHook(thief, sessionStartByClear, leftBehindId);
    await switchModel(thief);

    expect(lastLaunch().cliSessionId).toBe(thief);
  });

  it('lets the owner return to an id it left behind before a daemon restart', async () => {
    const owner = await runningSession();
    const leftBehindId = await userTypesClear(owner);
    await userTypesClear(owner, randomUUID(), leftBehindId);
    await restartDaemon();

    await sendHook(owner, sessionStartByResume, leftBehindId);
    await switchModel(owner);

    expect(lastLaunch().cliSessionId).toBe(leftBehindId);
  });

  it('lets the owner return to an id it left behind after clearing twice', async () => {
    const owner = await runningSession();
    const leftBehindId = await userTypesClear(owner);
    await userTypesClear(owner, randomUUID(), leftBehindId);

    await sendHook(owner, sessionStartByResume, leftBehindId);
    await switchModel(owner);

    expect(lastLaunch().cliSessionId).toBe(leftBehindId);
  });

  it("keeps resuming its own conversation when it reports another session's launch id after a daemon restart", async () => {
    const neighbour = await runningSession();
    const id = await runningSession();
    await restartDaemon();

    await sendHook(id, sessionStartByClear, neighbour);
    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(id);
  });
});

describe('the CLI session id reported by a cleared session', () => {
  it('is resumed in lower case when reported in upper case', async () => {
    const id = await runningSession();
    const clearedId = randomUUID();

    await userTypesClear(id, clearedId.toUpperCase());
    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });

  it.each(['not-a-uuid', '', '--dangerously-skip-permissions', `${randomUUID()} --model x`])('is ignored when it is %j, the launch conversation stays resumed', async (reported) => {
    const id = await runningSession();

    await userTypesClear(id, reported);
    await switchModel(id);

    expect(lastLaunch().cliSessionId).toBe(id);
  });

  it('is never shown by the sessions list', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    const body = await (await api('/api/sessions')).text();

    expect(body).not.toContain(clearedId);
    expect(body).not.toMatch(/cli_?session_?id/i);
  });
});
