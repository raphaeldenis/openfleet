import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '@openfleet/shared';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NEW_CONVERSATION_NOTICE = 'The previous conversation could not be found: started a new one.';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;
let bus: EventBus;
let terminalOutput: string;

const bootDaemon = async () => {
  bus = new EventBus();
  bus.subscribe((event: ServerEvent) => {
    if (event.type === 'session.output') terminalOutput += event.data;
  });
  const sessions = new SessionService({
    db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0,
    clearInFlightTimeoutMs: 50, clearFlushGraceMs: 0,
  });
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
  terminalOutput = '';
  await bootDaemon();
});

afterEach(async () => {
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

const userTypesClear = async (id: string) => {
  const clearedId = randomUUID();
  await sendHook(id, { hook_event_name: 'SessionEnd', reason: 'clear' });
  await sendHook(id, { hook_event_name: 'SessionStart', source: 'clear' }, clearedId);
  return clearedId;
};

const lastLaunch = () => harness.launches.at(-1)!;

const switchModel = async (id: string) => {
  const launchesBefore = harness.launches.length;
  await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });
  await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
};

const closeThenReopen = async (id: string) => {
  const launchesBefore = harness.launches.length;
  await postJson(`/api/sessions/${id}/close`);
  await postJson(`/api/sessions/${id}/reopen`);
  await expect.poll(() => harness.launches.length).toBe(launchesBefore + 1);
};

const sessionOf = async (id: string) => ((await (await api('/api/sessions')).json()) as { id: string; state: string }[]).find((session) => session.id === id)!;

const noticeCount = () => terminalOutput.split(NEW_CONVERSATION_NOTICE).length - 1;

describe('a user reopening a session whose conversation file is gone', () => {
  it('sees the same session start a new conversation instead of closing on a failed resume', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);

    await closeThenReopen(id);

    expect(lastLaunch().sessionId).toBe(id);
    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId).toMatch(UUID);
    expect(lastLaunch().cliSessionId).not.toBe(clearedId);
    expect(lastLaunch().cliSessionId).not.toBe(id);
    expect((await sessionOf(id)).state).not.toBe('closed');
  });

  it('is told once, in the terminal, that a new conversation was started', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);

    await closeThenReopen(id);

    expect(noticeCount()).toBe(1);
  });

  it('is told once per missing conversation, not on every later reopen', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);
    await closeThenReopen(id);
    const newConversationId = lastLaunch().cliSessionId!;

    await closeThenReopen(id);
    await closeThenReopen(id);

    expect(noticeCount()).toBe(1);
    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(newConversationId);
  });

  it('sees the missing conversation logged with the session and conversation ids only, no path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);

    await closeThenReopen(id);

    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('conversation not found'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(id);
    expect(lines[0]).toContain(clearedId);
    expect(lines[0]).toContain(lastLaunch().cliSessionId!);
    expect(lines[0]).not.toContain('/');
  });

  it('sees a reopen whose conversation is present resume it silently', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);

    await closeThenReopen(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(clearedId);
    expect(noticeCount()).toBe(0);
  });
});

describe('a user relaunching a session whose conversation file is gone', () => {
  it('sees a model switch start a new conversation on the same session, never the launch conversation', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId).not.toBe(id);
    expect(lastLaunch().cliSessionId).not.toBe(clearedId);
    expect(noticeCount()).toBe(1);
  });

  it('sees the daemon boot start a new conversation on the same session', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);

    await restartDaemon();

    expect(lastLaunch().sessionId).toBe(id);
    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId).not.toBe(clearedId);
  });

  it('sees a session that never got a prompt start a new conversation instead of resuming its launch id', async () => {
    const id = await runningSession();
    harness.missingConversations.add(id);

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId).toMatch(UUID);
    expect(lastLaunch().cliSessionId).not.toBe(id);
  });

  it('sees the new conversation kept after the CLI reports it on its first SessionStart', async () => {
    const id = await runningSession();
    harness.missingConversations.add(id);
    await switchModel(id);
    const newConversationId = lastLaunch().cliSessionId!;
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'startup' }, newConversationId);

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(newConversationId);
  });
});
