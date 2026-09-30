import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let projectDirectory: string;
let deliveredMessageIds: string[];
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'of-claude-config-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  projectDirectory = join(configDir, 'projects', 'proj');
  mkdirSync(projectDirectory, { recursive: true });

  const db = openDatabase(':memory:');
  const bus = new EventBus();
  deliveredMessageIds = [];
  bus.subscribe((event) => {
    if (event.type === 'message.delivered') deliveredMessageIds.push(event.messageId);
  });
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
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

const sendMessage = (id: string) => postJson(`/api/sessions/${id}/messages`, { body: 'hello' });

const assistantLine = (model: string) =>
  `${JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: new Date().toISOString(), version: '2.1.284', message: { role: 'assistant', model, content: [] } })}\n`;

const sessionEnd = (reason?: string) => ({ hook_event_name: 'SessionEnd', ...(reason === undefined ? {} : { reason }) });
const sessionStartAfterClear = { hook_event_name: 'SessionStart', source: 'clear' };
const preToolUse = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };

describe('a user typing /clear in a session', () => {
  it('keeps the session alive and answering messages after the CLI reports SessionEnd with reason clear', async () => {
    const id = await createSession();
    await sendHook(id, { hook_event_name: 'SessionStart' });

    const hookResponse = await sendHook(id, sessionEnd('clear'));

    expect(hookResponse.status).toBe(200);
    expect(await listed(id)).toMatchObject({ state: 'idle' });
    expect((await sendMessage(id)).status).not.toBe(409);
  });

  it('keeps a generating session alive, delivering its queued message and reading the launch transcript, when SessionEnd with reason clear is never followed by a SessionStart', async () => {
    const id = await createSession();
    writeFileSync(transcriptPathOf(id), '');
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    await sendHook(id, sessionEnd('clear'));

    await new Promise((resolve) => setTimeout(resolve, 300));
    const stateAfterWaiting = (await listed(id)).state;
    const queuedResponse = await sendMessage(id);
    writeFileSync(transcriptPathOf(id), assistantLine('claude-opus-5-5'));
    await sendHook(id, { hook_event_name: 'Stop', transcript_path: undefined });

    expect(stateAfterWaiting).toBe('generating');
    expect(await queuedResponse.json()).toMatchObject({ status: 'queued' });
    expect(deliveredMessageIds).toHaveLength(1);
    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
  });

  it('shows the session idle once the SessionStart with source clear follows the SessionEnd', async () => {
    const id = await createSession();
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    const newCliSessionId = randomUUID();

    await sendHook(id, sessionEnd('clear'));
    expect((await listed(id)).state).toBe('generating');
    await sendHook(id, sessionStartAfterClear, newCliSessionId);

    expect((await listed(id)).state).toBe('idle');
  });

  it.each([
    { order: 'SessionEnd then SessionStart', endFirst: true },
    { order: 'SessionStart then SessionEnd', endFirst: false },
  ])('shows the model of the new transcript when the CLI reports $order', async ({ endFirst }) => {
    const id = await createSession();
    const newCliSessionId = randomUUID();
    writeFileSync(transcriptPathOf(id), assistantLine('claude-opus-5-4'));
    writeFileSync(transcriptPathOf(newCliSessionId), '');

    if (endFirst) {
      await sendHook(id, sessionEnd('clear'));
      await sendHook(id, sessionStartAfterClear, newCliSessionId);
    } else {
      await sendHook(id, sessionStartAfterClear, newCliSessionId);
      await sendHook(id, sessionEnd('clear'));
    }
    writeFileSync(transcriptPathOf(newCliSessionId), assistantLine('claude-opus-5-5'));
    await sendHook(id, { ...preToolUse, transcript_path: undefined }, newCliSessionId);

    expect(await listed(id)).toMatchObject({ state: 'generating', resolvedModel: 'claude-opus-5-5' });
  });

  it('keeps reading the launch transcript when the SessionEnd with reason clear names a foreign transcript and no SessionStart follows', async () => {
    const id = await createSession();
    const foreignCliSessionId = randomUUID();
    writeFileSync(transcriptPathOf(id), '');
    await sendHook(id, { hook_event_name: 'SessionStart' });

    writeFileSync(transcriptPathOf(foreignCliSessionId), assistantLine('claude-opus-5-4'));
    await sendHook(id, sessionEnd('clear'), foreignCliSessionId);
    writeFileSync(transcriptPathOf(id), assistantLine('claude-opus-5-5'));
    await sendHook(id, { ...preToolUse, transcript_path: undefined });

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
  });
});

describe('a session that really ends', () => {
  it.each(['logout', 'prompt_input_exit', 'other', 'a_reason_added_by_a_future_cli', 'CLEAR', 'Clear', ' clear', 'clear\n', undefined])(
    'closes when the CLI reports SessionEnd with reason %s',
    async (reason) => {
      const id = await createSession();
      await sendHook(id, { hook_event_name: 'SessionStart' });

      await sendHook(id, sessionEnd(reason));

      expect((await listed(id)).state).toBe('closed');
      expect((await sendMessage(id)).status).toBe(409);
    },
  );
});
