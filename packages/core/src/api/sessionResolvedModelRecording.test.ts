import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const CLI_VERSION = '2.1.284';
const TAIL_WINDOW_BYTES = 256 * 1024;

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let projectDirectory: string;
let transcriptPath: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'of-claude-config-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  projectDirectory = join(configDir, 'projects', 'proj');
  mkdirSync(projectDirectory, { recursive: true });
  transcriptPath = join(projectDirectory, 'transcript.jsonl');

  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
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

interface ListedSession { id: string; model?: string; state: string; resolvedModel?: string; cliVersion?: string; modelDriftedFrom?: string }

const listSessions = async () => (await (await api('/api/sessions')).json()) as ListedSession[];
const listed = async (id: string) => (await listSessions()).find((session) => session.id === id)!;

const createSession = async (model?: string) => {
  const created = (await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model })).json()) as ListedSession;
  return created.id;
};

const hookTokenOf = async (id: string) => ((await (await api(`/api/sessions/${id}/tokens`)).json()) as { hookToken: string }).hookToken;

const sendHook = async (id: string, event: Record<string, unknown>, path: string | undefined = transcriptPath) => {
  const token = await hookTokenOf(id);
  return fetch(`${server.url}/hooks/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: id, transcript_path: path, ...event }),
  });
};

const preToolUse = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
const stop = { hook_event_name: 'Stop' };

const assistantLine = (fields: { model: unknown; version?: string; at?: Date; isSidechain?: boolean }) =>
  `${JSON.stringify({
    type: 'assistant', isSidechain: fields.isSidechain ?? false, timestamp: (fields.at ?? new Date()).toISOString(),
    version: fields.version ?? CLI_VERSION, message: { role: 'assistant', model: fields.model, content: [] },
  })}\n`;

const inOneSecond = () => new Date(Date.now() + 1000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('resolved model recording from a session\'s transcript', () => {
  it('shows the resolved model and CLI version of a session after its first tool use', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));

    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('shows the resolved model and CLI version after a turn that ends with Stop and used no tool', async () => {
    const id = await createSession('opus');
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));

    await sendHook(id, stop);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('streams one session.updated carrying the resolved model to a connected client, however many hooks follow', async () => {
    const id = await createSession('opus');
    const { ticket } = (await (await postJson('/api/ws-ticket')).json()) as { ticket: string };
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const received: { type: string; session?: ListedSession }[] = [];
    ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));

    await sendHook(id, preToolUse);
    await sendHook(id, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await sendHook(id, stop);
    await pause(50);
    ws.close();

    const updates = received.filter((event) => event.type === 'session.updated' && event.session?.id === id);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.session).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('answers hooks and shows no resolved model while the transcript file is missing, then while it is empty', async () => {
    const id = await createSession('opus');

    const withoutFile = await sendHook(id, preToolUse);
    const afterMissingFile = await listed(id);
    writeFileSync(transcriptPath, '');
    const withEmptyFile = await sendHook(id, preToolUse);
    const afterEmptyFile = await listed(id);

    expect(withoutFile.status).toBe(200);
    expect(withEmptyFile.status).toBe(200);
    expect(afterMissingFile).not.toHaveProperty('resolvedModel');
    expect(afterEmptyFile).not.toHaveProperty('resolvedModel');
    expect(afterEmptyFile).not.toHaveProperty('cliVersion');
  });

  it('ignores a half-written last line and shows the resolved model once the line is complete', async () => {
    const id = await createSession('opus');
    const completeLine = assistantLine({ model: 'claude-opus-5-5' });
    const halfLine = completeLine.slice(0, Math.floor(completeLine.length / 2));
    writeFileSync(transcriptPath, halfLine);

    const whileHalfWritten = await sendHook(id, preToolUse);
    const beforeCompletion = await listed(id);
    appendFileSync(transcriptPath, completeLine.slice(halfLine.length));
    await sendHook(id, preToolUse);
    const afterCompletion = await listed(id);

    expect(whileHalfWritten.status).toBe(200);
    expect(beforeCompletion).not.toHaveProperty('resolvedModel');
    expect(afterCompletion).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('shows the model of the new launch after a reopen, though the transcript still starts with the earlier launch\'s lines', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-4' }));
    await sendHook(id, preToolUse);
    await pause(10);
    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);

    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
  });

  it('shows no resolved model after a reopen while the transcript holds only the earlier launch\'s lines', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-4', at: new Date(Date.now() - 60_000) }));
    await pause(10);
    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);

    await sendHook(id, preToolUse);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('never shows the resolved model of a subagent, nor an invalid model value, and picks the first valid line after them', async () => {
    const id = await createSession('opus');
    const invalidModels = ['<synthetic>', '-leading-dash', 'x'.repeat(101), 'claude\nopus', 'has space', '', 42, null];
    writeFileSync(transcriptPath, [
      assistantLine({ model: 'claude-subagent-model', isSidechain: true }),
      ...invalidModels.map((model) => assistantLine({ model })),
    ].join(''));

    await sendHook(id, preToolUse);
    const afterHostileLines = await listed(id);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    const afterValidLine = await listed(id);

    expect(afterHostileLines).not.toHaveProperty('resolvedModel');
    expect(afterValidLine).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
  });

  it('never shows a CLI version that is not a version number', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5', version: '<script>alert(1)</script>' }));

    await sendHook(id, preToolUse);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('records nothing from a transcript named outside the projects directory', async () => {
    const id = await createSession('opus');
    const outsidePath = join(mkdtempSync(join(tmpdir(), 'of-outside-')), 'transcript.jsonl');
    writeFileSync(outsidePath, assistantLine({ model: 'claude-opus-5-5' }));

    await sendHook(id, preToolUse, outsidePath);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('records nothing from a transcript that is a symlink leaving the projects directory', async () => {
    const id = await createSession('opus');
    const outsideTarget = join(mkdtempSync(join(tmpdir(), 'of-outside-')), 'real.jsonl');
    writeFileSync(outsideTarget, assistantLine({ model: 'claude-opus-5-5' }));
    symlinkSync(outsideTarget, transcriptPath);

    await sendHook(id, preToolUse);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('answers hooks and records nothing when the transcript path is a named pipe nobody writes to', async () => {
    const id = await createSession('opus');
    execFileSync('mkfifo', [transcriptPath]);
    const writerAppearsAfterSeconds = 2;
    spawn('sh', ['-c', `sleep ${writerAppearsAfterSeconds}; exec 3<>"$0"`, transcriptPath], { stdio: 'ignore' }).unref();
    const startedAt = Date.now();

    const reply = await sendHook(id, preToolUse);
    const answeredAfterMs = Date.now() - startedAt;

    expect(reply.status).toBe(200);
    expect(answeredAfterMs).toBeLessThan(writerAppearsAfterSeconds * 1000 / 2);
    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  }, 10_000);

  it('finds the resolved model of a transcript far larger than the window read at the end of the file', async () => {
    const id = await createSession('opus');
    const filler = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } })}\n`;
    const fillerCount = Math.ceil((TAIL_WINDOW_BYTES * 2) / filler.length);
    writeFileSync(transcriptPath, [
      assistantLine({ model: 'claude-model-at-file-start' }),
      filler.repeat(fillerCount),
      assistantLine({ model: 'claude-model-near-file-end' }),
    ].join(''));

    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-near-file-end' });
  });

  it('shows the model id, never a stale one, after a model switch relaunches the session, then the new id', async () => {
    const id = await createSession('claude-opus-5-5');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    const beforeSwitch = await listed(id);

    await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });
    await expect.poll(() => harness.launches.length).toBe(2);
    const afterSwitch = await listed(id);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);
    const afterNewLaunchAnswered = await listed(id);

    expect(beforeSwitch).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
    expect(afterSwitch).not.toHaveProperty('resolvedModel');
    expect(afterNewLaunchAnswered).toMatchObject({ model: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5' });
  });

  it('picks up the newer resolution of an alias when the same alias is re-applied to an idle session', async () => {
    const id = await createSession('opus');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    const alias = (await listed(id)).model!;
    const beforeReapply = await listed(id);

    const reply = await postJson(`/api/sessions/${id}/model`, { model: alias });
    await expect.poll(() => harness.launches.length).toBe(2);
    const afterRelaunch = await listed(id);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);
    const afterNewLaunchAnswered = await listed(id);

    expect(await reply.json()).toEqual({ status: 'relaunching' });
    expect(beforeReapply).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
    expect(afterRelaunch).not.toHaveProperty('resolvedModel');
    expect(afterNewLaunchAnswered).toMatchObject({ resolvedModel: 'claude-opus-5-6' });
  });

  it('keeps the resolved model of a session whose model switch is deferred until the relaunch really happens', async () => {
    const id = await createSession('claude-opus-5-5');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });

    const reply = await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });
    const whileDeferred = await listed(id);
    await sendHook(id, stop);
    await expect.poll(() => harness.launches.length).toBe(2);
    const afterRelaunch = await listed(id);

    expect(await reply.json()).toEqual({ status: 'deferred' });
    expect(whileDeferred).toMatchObject({ model: 'claude-sonnet-5-5', resolvedModel: 'claude-opus-5-5' });
    expect(afterRelaunch).not.toHaveProperty('resolvedModel');
  });

  it('records nothing from a transcript swapped for a symlink leaving the projects directory between two hooks', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, '');
    const outsideTarget = join(mkdtempSync(join(tmpdir(), 'of-outside-')), 'real.jsonl');
    writeFileSync(outsideTarget, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);

    unlinkSync(transcriptPath);
    symlinkSync(outsideTarget, transcriptPath);
    await sendHook(id, preToolUse);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('keeps the resolved model of a session relaunched for a permission-mode change', async () => {
    const id = await createSession('claude-opus-5-5');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);

    await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' });
    await expect.poll(() => harness.launches.length).toBe(2);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('keeps the resolved model through a permission-mode relaunch that follows a deferred model switch abandoned by close and reopen', async () => {
    const id = await createSession('claude-opus-5-5');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    const switchReply = await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });
    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);
    await sendHook(id, { hook_event_name: 'SessionStart' });
    const afterReopen = await listed(id);

    const modeReply = (await (await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' })).json()) as { status: string };
    if (modeReply.status === 'deferred') await sendHook(id, stop);
    await expect.poll(() => harness.launches.length).toBe(3);
    const afterModeRelaunch = await listed(id);

    expect(await switchReply.json()).toEqual({ status: 'deferred' });
    expect(afterReopen).toMatchObject({ model: 'claude-sonnet-5-5', resolvedModel: 'claude-opus-5-5' });
    expect(afterModeRelaunch).toMatchObject({ model: 'claude-sonnet-5-5', resolvedModel: 'claude-opus-5-5' });
  });

  it('answers hooks and records nothing when the transcript path is a directory, then an unreadable file', async () => {
    const id = await createSession('opus');
    mkdirSync(transcriptPath);
    const withDirectory = await sendHook(id, preToolUse);
    const afterDirectory = await listed(id);
    rmdirSync(transcriptPath);
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    chmodSync(transcriptPath, 0o000);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const withUnreadableFile = await sendHook(id, preToolUse);
    const afterUnreadableFile = await listed(id);
    consoleErrorSpy.mockRestore();

    expect(withDirectory.status).toBe(200);
    expect(withUnreadableFile.status).toBe(200);
    expect(afterDirectory).not.toHaveProperty('resolvedModel');
    expect(afterUnreadableFile).not.toHaveProperty('resolvedModel');
  });

  it('logs a persistent transcript read failure once per launch, however many hooks follow', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    chmodSync(transcriptPath, 0o000);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendHook(id, preToolUse);
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    const resolvedModelErrors = consoleErrorSpy.mock.calls.filter((call) => String(call[0]).includes('resolved model'));
    consoleErrorSpy.mockRestore();

    expect(resolvedModelErrors).toHaveLength(1);
  });

  it.each(['2.1.284 trailing junk', '2.1.284-beta\n', `2.1.284${'a'.repeat(21)}`])('never shows the CLI version %j', async (version) => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5', version }));

    await sendHook(id, preToolUse);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('shows the resolved model of an assistant line written at the very instant the session launched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const launchInstant = new Date('2026-09-29T10:00:00.000Z');
    vi.setSystemTime(launchInstant);
    try {
      const id = await createSession('opus');
      writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5', at: launchInstant }));

      await sendHook(id, preToolUse);

      expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the assistant line that starts exactly where the tail window starts', async () => {
    const id = await createSession('opus');
    const paddingLine = (bytes: number) => {
      const emptyPaddingLine = `${JSON.stringify({ type: 'user', pad: '' })}\n`;
      return `${JSON.stringify({ type: 'user', pad: 'x'.repeat(bytes - emptyPaddingLine.length) })}\n`;
    };
    const targetLine = assistantLine({ model: 'claude-model-at-window-start', at: inOneSecond() });
    writeFileSync(transcriptPath, [paddingLine(100), targetLine, paddingLine(TAIL_WINDOW_BYTES - targetLine.length)].join(''));

    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-at-window-start' });
  });

  it('relaunches a session with the alias it was launched with, never with the model id recorded for it', async () => {
    const id = await createSession('opus');
    const requestedModel = (await listed(id)).model;
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-9' }));
    await sendHook(id, preToolUse);
    await postJson(`/api/sessions/${id}/close`);

    await postJson(`/api/sessions/${id}/reopen`);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-9' });
    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]!.model).toBe(requestedModel);
    expect(harness.launches[1]!.model).not.toBe('claude-opus-5-9');
  });
});
