import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import type { HarnessLaunch } from '../harness/harness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;
let projectDirectory: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

const bootDaemon = async () => {
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
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
  const configDir = mkdtempSync(join(tmpdir(), 'of-claude-config-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  projectDirectory = join(configDir, 'projects', 'proj');
  mkdirSync(projectDirectory, { recursive: true });

  db = openDatabase(':memory:');
  harness = new FakeHarness();
  await bootDaemon();
});

afterEach(async () => {
  await server.close();
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });

const postJson = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

interface ListedSession { id: string; state: string; resolvedModel?: string }

const listed = async (id: string) => ((await (await api('/api/sessions')).json()) as ListedSession[]).find((session) => session.id === id)!;

const transcriptPathOf = (cliSessionId: string) => join(projectDirectory, `${cliSessionId}.jsonl`);

const createSession = async () => ((await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model: 'opus' })).json()) as ListedSession).id;

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
const sessionStartByClear = { hook_event_name: 'SessionStart', source: 'clear' };
const preToolUse = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };

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

const conversationResumedBy = (launch: HarnessLaunch) => launch.cliSessionId ?? launch.sessionId;
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

const assistantLine = (model: string) =>
  `${JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: new Date(Date.now() + 1000).toISOString(), version: '2.1.284', message: { role: 'assistant', model, content: [] } })}\n`;

describe('a user relaunching a session after typing /clear', () => {
  it('sees a model switch relaunch the session on the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(clearedId);
    expect(lastLaunch().sessionId).toBe(id);
    expect(lastLaunch().resuming).toBe(true);
  });

  it('sees a permission-mode change relaunch the session on the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await changePermissionMode(id);

    expect(conversationResumedBy(lastLaunch())).toBe(clearedId);
  });

  it('sees a closed then reopened session resume the cleared conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await closeThenReopen(id);

    expect(conversationResumedBy(lastLaunch())).toBe(clearedId);
  });

  it('sees the cleared conversation resumed after a daemon restart', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await restartDaemon();

    expect(conversationResumedBy(lastLaunch())).toBe(clearedId);
  });

  it('sees a session cleared twice relaunch on the second cleared conversation', async () => {
    const id = await runningSession();
    const firstClearedId = await userTypesClear(id);
    const secondClearedId = await userTypesClear(id, randomUUID(), firstClearedId);

    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(secondClearedId);
  });

  it('sees a session that was never cleared relaunch on its launch conversation', async () => {
    const id = await runningSession();

    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(id);
  });

  it('sees a session whose SessionEnd with reason clear was not followed by a SessionStart relaunch on its launch conversation', async () => {
    const id = await runningSession();
    await sendHook(id, sessionEndByClear, randomUUID());

    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(id);
  });
});

describe('a session reporting a CLI session id that is not its own', () => {
  it("keeps resuming its own conversation when it reports another session's launch id", async () => {
    const neighbour = await runningSession();
    const id = await runningSession();

    await sendHook(id, sessionStartByClear, neighbour);
    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(id);
  });

  it("keeps resuming its own cleared conversation when it reports another session's cleared id, also after a daemon restart", async () => {
    const neighbour = await runningSession();
    const neighbourClearedId = await userTypesClear(neighbour);
    const id = await runningSession();
    const ownClearedId = await userTypesClear(id);

    await sendHook(id, sessionStartByClear, neighbourClearedId);
    await switchModel(id);
    const resumedBeforeRestart = conversationResumedBy(lastLaunch());
    await restartDaemon();
    await sendHook(id, sessionStartByClear, neighbourClearedId);
    await switchModel(id);
    const resumedAfterRestart = conversationResumedBy(lastLaunch());

    expect(resumedBeforeRestart).toBe(ownClearedId);
    expect(resumedAfterRestart).toBe(ownClearedId);
  });

  it("keeps resuming its own conversation when it reports another session's launch id after a daemon restart", async () => {
    const neighbour = await runningSession();
    const id = await runningSession();
    await restartDaemon();

    await sendHook(id, sessionStartByClear, neighbour);
    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(id);
  });
});

describe('the CLI session id reported by a cleared session', () => {
  it('is resumed in lower case when reported in upper case', async () => {
    const id = await runningSession();
    const clearedId = randomUUID();

    await userTypesClear(id, clearedId.toUpperCase());
    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(clearedId);
  });

  it.each(['not-a-uuid', '', '--dangerously-skip-permissions', `${randomUUID()} --model x`])('is ignored when it is %j, the launch conversation stays resumed', async (reported) => {
    const id = await runningSession();

    await userTypesClear(id, reported);
    await switchModel(id);

    expect(conversationResumedBy(lastLaunch())).toBe(id);
  });

  it('is never shown by the sessions list', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    const body = await (await api('/api/sessions')).text();

    expect(body).not.toContain(clearedId);
    expect(body).not.toMatch(/cli_?session_?id/i);
  });
});

describe('the resolved model of a cleared session that was reopened', () => {
  it('is recorded from the cleared conversation transcript at the first tool use, with no SessionStart in between', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    await closeThenReopen(id);
    writeFileSync(transcriptPathOf(clearedId), assistantLine('claude-opus-5-5'));

    await sendHook(id, preToolUse, clearedId);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
  });

  it('records nothing from a transcript named after the launch id', async () => {
    const id = await runningSession();
    await userTypesClear(id);
    await closeThenReopen(id);
    writeFileSync(transcriptPathOf(id), assistantLine('claude-opus-5-5'));

    await sendHook(id, preToolUse, id);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });
});
