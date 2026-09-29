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

let service: SessionService;

const bootDaemon = async (clearTimings: { clearInFlightTimeoutMs: number; clearFlushGraceMs: number } = { clearInFlightTimeoutMs: 50, clearFlushGraceMs: 0 }) => {
  bus = new EventBus();
  bus.subscribe((event: ServerEvent) => {
    if (event.type === 'session.output') terminalOutput += event.data;
  });
  const sessions = new SessionService({
    db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0,
    ...clearTimings,
  });
  service = sessions;
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

const userPrompts = async (id: string, cliSessionId: string = id) => {
  harness.markPrompted(cliSessionId);
  await sendHook(id, { hook_event_name: 'UserPromptSubmit', user_prompt: 'hello' }, cliSessionId);
  await sendHook(id, { hook_event_name: 'Stop' }, cliSessionId);
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

  it('is told once per lost conversation: reopening the new one before any prompt starts no other and says nothing', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);
    await closeThenReopen(id);
    const newConversationId = lastLaunch().cliSessionId!;

    await closeThenReopen(id);
    await closeThenReopen(id);

    expect(noticeCount()).toBe(1);
    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId).toBe(newConversationId);
  });

  it('resumes the new conversation on every later reopen once a prompt reached it, and says nothing', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);
    await closeThenReopen(id);
    const newConversationId = lastLaunch().cliSessionId!;
    await userPrompts(id, newConversationId);

    await closeThenReopen(id);
    await closeThenReopen(id);

    expect(noticeCount()).toBe(1);
    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(newConversationId);
  });

  it('is told again when a conversation that got a prompt is lost, after an earlier one was lost', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);
    await closeThenReopen(id);
    const secondConversationId = lastLaunch().cliSessionId!;
    await userPrompts(id, secondConversationId);
    harness.missingConversations.add(secondConversationId);

    await closeThenReopen(id);

    expect(noticeCount()).toBe(2);
    expect(lastLaunch().cliSessionId).not.toBe(secondConversationId);
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

  it('sees a session whose launch conversation got prompts and is gone start a new conversation and be told', async () => {
    const id = await runningSession();
    await userPrompts(id);
    harness.missingConversations.add(id);

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId).toMatch(UUID);
    expect(lastLaunch().cliSessionId).not.toBe(id);
    expect(noticeCount()).toBe(1);
  });

  it('sees the new conversation kept after the CLI reports it on its first SessionStart and a prompt reached it', async () => {
    const id = await runningSession();
    await userPrompts(id);
    harness.missingConversations.add(id);
    await switchModel(id);
    const newConversationId = lastLaunch().cliSessionId!;
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'startup' }, newConversationId);
    await userPrompts(id, newConversationId);

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(newConversationId);
  });
});

describe('a user switching the model of a session that never got a prompt', () => {
  it('sees it relaunch on its own conversation id, silently, since there never was a conversation to lose', async () => {
    const id = await runningSession();

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId ?? lastLaunch().sessionId).toBe(id);
    expect(noticeCount()).toBe(0);
  });

  it('sees every further switch and reopen do the same, without starting a conversation each time', async () => {
    const id = await runningSession();
    await switchModel(id);

    await closeThenReopen(id);
    await closeThenReopen(id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId ?? lastLaunch().sessionId).toBe(id);
    expect(noticeCount()).toBe(0);
  });

  it('sees the daemon boot relaunch it on its own conversation id, silently', async () => {
    const id = await runningSession();

    await restartDaemon();

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().cliSessionId ?? lastLaunch().sessionId).toBe(id);
    expect(noticeCount()).toBe(0);
  });

  it('sees it resume its conversation once a prompt reached it', async () => {
    const id = await runningSession();
    await switchModel(id);
    await userPrompts(id);

    await switchModel(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId ?? lastLaunch().sessionId).toBe(id);
  });
});

describe('a user relaunching a session whose conversation the daemon cannot inspect', () => {
  it('sees the stored conversation resumed as is, never replaced by a new one, and no notice', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.unreadableConversations.add(clearedId);

    await closeThenReopen(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(clearedId);
    expect(noticeCount()).toBe(0);
  });

  it('sees the same conversation resumed after the daemon can read it again', async () => {
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.unreadableConversations.add(clearedId);
    await closeThenReopen(id);
    harness.unreadableConversations.delete(clearedId);

    await closeThenReopen(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(clearedId);
  });

  it('sees the uninspectable conversation logged with the session and conversation ids only, no path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.unreadableConversations.add(clearedId);

    await closeThenReopen(id);

    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('conversation state unknown'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(id);
    expect(lines[0]).toContain(clearedId);
    expect(lines[0]).not.toContain('/');
  });
});

describe('a user whose terminal listener fails while a new conversation is announced', () => {
  it('keeps the relaunched process tracked, so closing the session still kills it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);
    bus.subscribe((event: ServerEvent) => {
      if (event.type === 'session.output' && event.data.includes('could not be found')) throw new Error('listener on a closing socket');
    });

    await closeThenReopen(id);
    const relaunchedHandle = harness.handles.at(-1)!;
    const isLeftRunning = !relaunchedHandle.killed && (await sessionOf(id)).state !== 'closed';
    await postJson(`/api/sessions/${id}/close`);

    expect(isLeftRunning).toBe(true);
    expect(relaunchedHandle.killed).toBe(true);
    expect((await sessionOf(id)).state).toBe('closed');
  });

  it('keeps the new conversation for the next relaunch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = await runningSession();
    const clearedId = await userTypesClear(id);
    harness.missingConversations.add(clearedId);
    bus.subscribe((event: ServerEvent) => {
      if (event.type === 'session.output' && event.data.includes('could not be found')) throw new Error('listener on a closing socket');
    });
    await closeThenReopen(id);
    const newConversationId = lastLaunch().cliSessionId!;
    await userPrompts(id, newConversationId);

    await closeThenReopen(id);

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(newConversationId);
  });
});

describe('a user closing a session while a /clear is still in flight', () => {
  const LONG_CLEAR_TIMINGS = { clearInFlightTimeoutMs: 60_000, clearFlushGraceMs: 60_000 };
  const bootWithLongClearHold = async () => {
    await server.close();
    await bootDaemon(LONG_CLEAR_TIMINGS);
  };

  it('sees the reopened session switch its model at once, not after the stale hold of the closed process', async () => {
    await bootWithLongClearHold();
    const id = await runningSession();
    await sendHook(id, { hook_event_name: 'SessionEnd', reason: 'clear' });
    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'resume' });

    await switchModel(id);

    expect(lastLaunch().sessionId).toBe(id);
  });

  it('sees the flush of the new conversation finish before a daemon shutdown kills the process', async () => {
    await server.close();
    await bootDaemon({ clearInFlightTimeoutMs: 60_000, clearFlushGraceMs: 300 });
    const id = await runningSession();
    await userTypesClear(id);
    const handle = harness.handles.at(-1)!;

    const shuttingDown = service.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const isKilledDuringFlush = handle.killed;
    await shuttingDown;

    expect(isKilledDuringFlush).toBe(false);
    expect(handle.killed).toBe(true);
  });

  it('sees a daemon shutdown with a /clear that never reached its flush kill the process without waiting', async () => {
    await server.close();
    await bootDaemon({ clearInFlightTimeoutMs: 60_000, clearFlushGraceMs: 60_000 });
    const id = await runningSession();
    await sendHook(id, { hook_event_name: 'SessionEnd', reason: 'clear' });
    const handle = harness.handles.at(-1)!;

    await service.closeAll();

    expect(handle.killed).toBe(true);
  });
});
