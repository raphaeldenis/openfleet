import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKING_STATE_TOOL_NAMES, type NotificationTrigger, type ServerEvent } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticToken } from '../syntheticTokens.js';
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

const FAIL_FAST_MS = 1000;
const APPROVAL_TIMEOUT_MS = 100;
const SECRET_TOOL_INPUT = syntheticToken({ shape: 'openai', bodyLength: 19 });
const SECRET_TRANSCRIPT_TEXT = 'TRANSCRIPT-SECRET-TEXT';
const SECRET_NOTIFICATION_MESSAGE = 'NOTIFICATION-SECRET-MESSAGE';
const SECRET_QUESTION_TEXT = 'QUESTION-SECRET-TEXT';
const SECRET_TOOL_RESPONSE = 'TOOL-RESPONSE-SECRET';

let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let workingStateSettings: WorkingStateSettings;
let workingStates: WorkingStateService;
let harness: FakeHarness;

async function startFixture() {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: APPROVAL_TIMEOUT_MS });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  workingStateSettings = { maxBytes: 8192, enforce: false, maxAgeMinutes: 30 };
  const clock = () => new Date().toISOString();
  workingStates = new WorkingStateService({ db, clock, stateRoot: mkdtempSync(join(tmpdir(), 'of-notif-mirror-')), maxBytes: workingStateSettings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings: workingStateSettings, clock });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings: workingStateSettings, clock });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', workingStates, stopRefusal, sessionStartContext });
}

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const postHook = async (sessionId: string, body: Record<string, unknown>) => {
  const response = await fetch(`${server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<{ decision?: string }>;
};
const startTurn = (sessionId: string) => postHook(sessionId, { hook_event_name: 'UserPromptSubmit', prompt: 'work' });
const stopTurn = (sessionId: string, extra: Record<string, unknown> = {}) => postHook(sessionId, { hook_event_name: 'Stop', ...extra });
const notify = (sessionId: string, notificationType: string) => postHook(sessionId, { hook_event_name: 'Notification', notification_type: notificationType });
const askPermission = (sessionId: string, toolName: string, toolInput: unknown = { command: 'ls' }) => postHook(sessionId, { hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput });
const toolRan = (sessionId: string, toolName: string, toolUseId: string | undefined, extra: Record<string, unknown> = {}) =>
  postHook(sessionId, { hook_event_name: 'PostToolUse', tool_name: toolName, ...(toolUseId && { tool_use_id: toolUseId }), tool_input: { command: SECRET_TOOL_INPUT }, tool_response: SECRET_TOOL_RESPONSE, ...extra });
const toolAboutToRun = (sessionId: string, toolName: string, toolUseId: string, extra: Record<string, unknown> = {}) =>
  postHook(sessionId, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_use_id: toolUseId, tool_input: {}, ...extra });
const agentStateAsking = (questionsForHuman: string[]) => ({ plan: [], todo: [], remaining: [], questionsForHuman, internalQuestions: [], blockers: [] });
const createSessionAtIdle = async (name = 'Builder') => {
  const session = await sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🛠' });
  await postHook(session.id, { hook_event_name: 'SessionStart', source: 'startup' });
  return session;
};

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

const failFast = <T>(promise: Promise<T>, expectation: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${FAIL_FAST_MS} ms: ${expectation}`)), FAIL_FAST_MS))]);

// Events reach a client in order: once the marker rename has arrived, everything emitted before it has too.
async function framesAfterSettling(connection: Connection, markerSessionId: string): Promise<ServerEvent[]> {
  const marker = new Promise<void>((resolve) => connection.ws.addEventListener('message', (message) => { if (JSON.parse(String(message.data)).type === 'session.updated') resolve(); }));
  sessions.rename(markerSessionId, { name: 'marker' });
  await failFast(marker, 'the settle marker never reached the client');
  return connection.received;
}

const countOf = (triggers: NotificationTrigger[], category: NotificationTrigger['category']) => triggers.filter((trigger) => trigger.category === category).length;
const typedBodies = () => harness.handles.flatMap((handle) => handle.written);

const triggersOf = (frames: ServerEvent[]): NotificationTrigger[] =>
  frames.flatMap((frame) => {
    if (frame.type !== 'notification.trigger') return [];
    const { type: _type, ...trigger } = frame;
    return [trigger];
  });

const settledTriggers = async (connection: Connection, markerSessionId: string) => triggersOf(await framesAfterSettling(connection, markerSessionId));

beforeEach(startFixture);
afterEach(() => server.close());

describe('user is told once when an agent finished its turn', () => {
  it('announces exactly one agentFinished for the Stop that ends a turn', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await stopTurn(session.id);

    expect(await settledTriggers(connection, session.id)).toEqual([{ category: 'agentFinished', sessionId: session.id }]);
  });

  it('announces nothing when Escape interrupts the turn', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    sessions.applyInput(session.id, { kind: 'transcript_interrupted' });

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });

  it('announces nothing for idle_prompt reminders after the turn ended, and nothing again for a replayed Stop', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await stopTurn(session.id);
    await notify(session.id, 'idle_prompt');
    await notify(session.id, 'idle_prompt');
    await stopTurn(session.id);

    expect(await settledTriggers(connection, session.id)).toHaveLength(1);
  });

  it('announces nothing for a Stop the daemon blocks, then exactly one for the final Stop that follows the block', async () => {
    workingStateSettings.enforce = true;
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    const blocked = await stopTurn(session.id);
    const triggersAfterBlock = triggersOf(await framesAfterSettling(connection, session.id));
    await stopTurn(session.id, { stop_hook_active: true });

    expect(blocked.decision).toBe('block');
    expect(triggersAfterBlock).toEqual([]);
    expect(await settledTriggers(connection, session.id)).toEqual([{ category: 'agentFinished', sessionId: session.id }]);
  });

  it('announces exactly one agentFinished for the Stop of a turn whose start was never reported, and none for the same Stop replayed', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    sessions.sendMessage({ sessionId: session.id, body: 'work started before a daemon restart' });
    await vi.waitFor(() => expect(typedBodies()).toContain('\r'));
    await stopTurn(session.id);
    await stopTurn(session.id);

    expect(await settledTriggers(connection, session.id)).toEqual([{ category: 'agentFinished', sessionId: session.id }]);
  });

  it('announces one agentFinished for a Stop that ends a turn while the agent waits for permission', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await notify(session.id, 'permission_prompt');
    await stopTurn(session.id);

    const triggers = await settledTriggers(connection, session.id);
    expect(countOf(triggers, 'agentFinished')).toBe(1);
    expect(countOf(triggers, 'needsInput')).toBe(1);
  });

  it('announces one agentFinished for a Stop that ends a turn while the agent waits for an answer', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await notify(session.id, 'agent_needs_input');
    await stopTurn(session.id);

    const triggers = await settledTriggers(connection, session.id);
    expect(countOf(triggers, 'agentFinished')).toBe(1);
    expect(countOf(triggers, 'needsInput')).toBe(1);
  });

  it('announces nothing for a session that is closed', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await sessions.close(session.id);
    await stopTurn(session.id);

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });
});

describe('user is told once when an agent needs them', () => {
  it('announces one needsInput for a permission prompt, however many signals describe the same prompt', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    const permissionAnswer = askPermission(session.id, 'Bash');
    await notify(session.id, 'permission_prompt');
    await notify(session.id, 'idle_prompt');
    await permissionAnswer;

    const frames = await framesAfterSettling(connection, session.id);
    const waitingSince = frames.flatMap((frame) => (frame.type === 'session.state' && frame.state === 'waiting_permission' ? [frame.stateSince] : []));
    expect(frames.some((frame) => frame.type === 'approval.created')).toBe(true);
    expect(triggersOf(frames)).toEqual([{ category: 'needsInput', sessionId: session.id, kind: 'permission', promptKey: `${session.id}@${waitingSince[0]}`, toolName: 'Bash' }]);
  });

  it('announces a second needsInput for a second prompt of the same session', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await askPermission(session.id, 'Bash');
    await postHook(session.id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await askPermission(session.id, 'Edit');

    const triggers = await settledTriggers(connection, session.id);
    const promptKeys = triggers.flatMap((trigger) => (trigger.category === 'needsInput' ? [trigger.promptKey] : []));
    expect(triggers).toHaveLength(2);
    expect(promptKeys[0]).not.toBe(promptKeys[1]);
  });

  it('announces one needsInput of kind input when the agent asks a question, and none for the idle_prompt reminders that follow', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await notify(session.id, 'agent_needs_input');
    await notify(session.id, 'idle_prompt');
    await notify(session.id, 'idle_prompt');

    expect(await settledTriggers(connection, session.id)).toEqual([expect.objectContaining({ category: 'needsInput', sessionId: session.id, kind: 'input' })]);
  });

  it.each(WORKING_STATE_TOOL_NAMES)('announces nothing for a permission request on %s, which the daemon allows itself', async (workingStateTool) => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await askPermission(session.id, workingStateTool);

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });

  it('announces nothing for a session that is closed', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await sessions.close(session.id);
    await notify(session.id, 'agent_needs_input');

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });
});

describe('user is told once per tool run of a top-level agent', () => {
  it('announces one toolCompletion carrying the tool name for a PostToolUse, and nothing again for the same tool_use_id replayed', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolRan(session.id, 'Bash', 'toolu_1');
    await toolRan(session.id, 'Bash', 'toolu_1');

    expect(await settledTriggers(connection, session.id)).toEqual([{ category: 'toolCompletion', sessionId: session.id, toolUseId: 'toolu_1', toolName: 'Bash' }]);
  });

  it('announces one toolCompletion per distinct tool_use_id, and still one for a top-level PreToolUse that precedes its PostToolUse', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolAboutToRun(session.id, 'Read', 'toolu_1');
    await toolRan(session.id, 'Read', 'toolu_1');
    await toolRan(session.id, 'Edit', 'toolu_2');

    const triggers = await settledTriggers(connection, session.id);
    expect(triggers.map((trigger) => trigger.category === 'toolCompletion' && trigger.toolUseId)).toEqual(['toolu_1', 'toolu_2']);
  });

  it('announces nothing for a tool run by a sub-agent', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolRan(session.id, 'Bash', 'toolu_sub', { agent_id: 'agent-1', agent_type: 'general-purpose' });

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });

  it('announces nothing for a PostToolUse that lacks agent_id when its PreToolUse named a sub-agent', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolAboutToRun(session.id, 'Bash', 'toolu_sub', { agent_id: 'agent-1', agent_type: 'general-purpose' });
    await toolRan(session.id, 'Bash', 'toolu_sub');

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });

  it('announces nothing for a PostToolUse without a tool_use_id', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolRan(session.id, 'Bash', undefined);

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });

  it.each([...WORKING_STATE_TOOL_NAMES, 'TodoWrite', 'TaskUpdate'])('announces nothing for the daemon-owned tool %s', async (daemonOwnedTool) => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolRan(session.id, daemonOwnedTool, 'toolu_own');

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });

  it('announces nothing for a session that is closed', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await sessions.close(session.id);
    await toolRan(session.id, 'Bash', 'toolu_late');

    expect(await settledTriggers(connection, session.id)).toEqual([]);
  });
});

describe('user is told once when an agent asks them a new question', () => {
  const askQuestions = (sessionId: string, questions: string[]) => workingStates.update(sessionId, agentStateAsking(questions));
  const chatMessagesOf = (triggers: NotificationTrigger[]) => triggers.filter((trigger) => trigger.category === 'chatMessage');

  it('announces one chatMessage with the question count for a new question, and nothing for the same state sent again', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    askQuestions(session.id, ['Which database?']);
    askQuestions(session.id, ['Which database?']);

    const triggers = await settledTriggers(connection, session.id);
    expect(triggers).toEqual([{ category: 'chatMessage', sessionId: session.id, questionKey: expect.stringMatching(new RegExp(`^${session.id}@`)), questionCount: 1 }]);
  });

  it('announces one chatMessage counting only the questions that are new, when the agent adds one to an old one', async () => {
    const session = await createSessionAtIdle();
    askQuestions(session.id, ['Which database?']);
    const connection = await connect();

    askQuestions(session.id, ['Which database?', 'Which region?', 'Which tenant?']);

    expect(chatMessagesOf(await settledTriggers(connection, session.id))).toEqual([expect.objectContaining({ questionCount: 2 })]);
  });

  it('announces a new chatMessage for a question whose text changed', async () => {
    const session = await createSessionAtIdle();
    askQuestions(session.id, ['Which database?']);
    const connection = await connect();

    askQuestions(session.id, ['Which database engine?']);

    expect(chatMessagesOf(await settledTriggers(connection, session.id))).toHaveLength(1);
  });

  it('announces nothing when a question is answered and removed, reordered or a non-question section changes', async () => {
    const session = await createSessionAtIdle();
    askQuestions(session.id, ['Which database?', 'Which region?']);
    const connection = await connect();

    askQuestions(session.id, ['Which region?', 'Which database?']);
    askQuestions(session.id, ['Which region?']);
    workingStates.update(session.id, { ...agentStateAsking(['Which region?']), plan: ['a new plan'] });
    askQuestions(session.id, []);

    expect(chatMessagesOf(await settledTriggers(connection, session.id))).toEqual([]);
  });

  it('announces again a question that was removed and later asked anew', async () => {
    const session = await createSessionAtIdle();
    askQuestions(session.id, ['Which database?']);
    askQuestions(session.id, []);
    const connection = await connect();

    askQuestions(session.id, ['Which database?']);

    expect(chatMessagesOf(await settledTriggers(connection, session.id))).toHaveLength(1);
  });

  it('announces nothing for a session that is closed', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await sessions.close(session.id);
    askQuestions(session.id, ['Which database?']);

    expect(chatMessagesOf(await settledTriggers(connection, session.id))).toEqual([]);
  });
});

describe('a client that connects later', () => {
  it('receives no announcement of tool runs and questions from before it connected', async () => {
    const session = await createSessionAtIdle();
    await startTurn(session.id);
    await toolRan(session.id, 'Bash', 'toolu_old');
    workingStates.update(session.id, agentStateAsking(['Which database?']));

    const lateConnection = await connect();

    expect(await settledTriggers(lateConnection, session.id)).toEqual([]);
  });

  it('receives no announcement of what happened before it connected', async () => {
    const session = await createSessionAtIdle();
    await startTurn(session.id);
    await notify(session.id, 'agent_needs_input');
    await stopTurn(session.id);

    const lateConnection = await connect();

    expect(await settledTriggers(lateConnection, session.id)).toEqual([]);
  });
});

describe('what an announcement reveals', () => {
  it('carries identifiers and the tool name, never the tool input nor the transcript text', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await askPermission(session.id, 'Bash', { command: SECRET_TOOL_INPUT });
    await stopTurn(session.id, { last_assistant_message: SECRET_TRANSCRIPT_TEXT });

    const announcements = JSON.stringify(await settledTriggers(connection, session.id));
    expect(announcements).toContain('Bash');
    expect(announcements).not.toContain(SECRET_TOOL_INPUT);
    expect(announcements).not.toContain(SECRET_TRANSCRIPT_TEXT);
  });

  it('never carries the tool input, the tool response nor the text of a question', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await toolRan(session.id, 'Bash', 'toolu_1');
    workingStates.update(session.id, agentStateAsking([SECRET_QUESTION_TEXT]));

    const triggers = await settledTriggers(connection, session.id);
    const announcements = JSON.stringify(triggers);
    expect(triggers).toHaveLength(2);
    expect(announcements).toContain('Bash');
    for (const secret of [SECRET_TOOL_INPUT, SECRET_TOOL_RESPONSE, SECRET_QUESTION_TEXT]) expect(announcements).not.toContain(secret);
  });

  it('never carries the text of the Notification that asks for the human', async () => {
    const session = await createSessionAtIdle();
    const connection = await connect();

    await startTurn(session.id);
    await postHook(session.id, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: SECRET_NOTIFICATION_MESSAGE });

    const announcements = JSON.stringify(await settledTriggers(connection, session.id));
    expect(announcements).toContain('needsInput');
    expect(announcements).not.toContain(SECRET_NOTIFICATION_MESSAGE);
  });
});
