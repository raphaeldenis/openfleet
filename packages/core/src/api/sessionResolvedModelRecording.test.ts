import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { TRANSCRIPT_TAIL_WINDOW_BYTES } from '../sessions/resolvedModel.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const CLI_VERSION = '2.1.284';
// Skipped as root: root reads a file whose mode is 0o000, so the read failure these tests need never happens.
const isRunningAsRoot = process.getuid?.() === 0;

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let projectDirectory: string;
let transcriptPath: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

let db: ReturnType<typeof openDatabase>;
let daemonSessions: SessionService;

const bootDaemon = async () => {
  const bus = new EventBus();
  daemonSessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions: daemonSessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions: daemonSessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: daemonSessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
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

interface ListedSession { id: string; model?: string; state: string; resolvedModel?: string; cliVersion?: string; modelDriftedFrom?: string }

const listSessions = async () => (await (await api('/api/sessions')).json()) as ListedSession[];
const listed = async (id: string) => (await listSessions()).find((session) => session.id === id)!;

const transcriptPathOf = (cliSessionId: string) => join(projectDirectory, `${cliSessionId}.jsonl`);

const createSession = async (model?: string) => {
  const created = (await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model })).json()) as ListedSession;
  transcriptPath = transcriptPathOf(created.id);
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

const sessionWithRecordedOpus = async ({ requestedModel, stopped }: { requestedModel: string; stopped: boolean }) => {
  const id = await createSession(requestedModel);
  await sendHook(id, { hook_event_name: 'SessionStart' });
  writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
  await sendHook(id, preToolUse);
  await sendHook(id, stopped ? stop : { hook_event_name: 'UserPromptSubmit' });
  return id;
};

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
    const fillerCount = Math.ceil((TRANSCRIPT_TAIL_WINDOW_BYTES * 2) / filler.length);
    writeFileSync(transcriptPath, [
      assistantLine({ model: 'claude-model-at-file-start' }),
      filler.repeat(fillerCount),
      assistantLine({ model: 'claude-model-near-file-end' }),
    ].join(''));

    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-near-file-end' });
  });

  it('shows the model id, never a stale one, after a model switch relaunches the session, then the new id', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'claude-opus-5-5', stopped: true });
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
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: true });
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
    const id = await sessionWithRecordedOpus({ requestedModel: 'claude-opus-5-5', stopped: true });

    await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' });
    await expect.poll(() => harness.launches.length).toBe(2);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('keeps the resolved model through a permission-mode relaunch that follows a deferred model switch abandoned by close and reopen', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'claude-opus-5-5', stopped: false });
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

  it.skipIf(isRunningAsRoot)('answers hooks and records nothing when the transcript path is a directory, then an unreadable file', async () => {
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

  it.skipIf(isRunningAsRoot)('logs a persistent transcript read failure once per launch, however many hooks follow', async () => {
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

  it.skipIf(isRunningAsRoot)('logs a persistent read failure again after the session is relaunched', async () => {
    const id = await createSession('opus');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    chmodSync(transcriptPath, 0o000);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    const alias = (await listed(id)).model!;

    await postJson(`/api/sessions/${id}/model`, { model: alias });
    await expect.poll(() => harness.launches.length).toBe(2);
    await sendHook(id, preToolUse);
    const resolvedModelErrors = consoleErrorSpy.mock.calls.filter((call) => String(call[0]).includes('resolved model'));
    consoleErrorSpy.mockRestore();

    expect(resolvedModelErrors).toHaveLength(2);
  });

  it.each(['2.1.284 trailing junk', '2.1.284-beta\n', `2.1.284${'a'.repeat(21)}`, '<script>alert(1)</script>'])('never shows the CLI version %j', async (version) => {
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
    writeFileSync(transcriptPath, [paddingLine(100), targetLine, paddingLine(TRANSCRIPT_TAIL_WINDOW_BYTES - targetLine.length)].join(''));

    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-at-window-start' });
  });

  it('describes the still-running old process while a model switch is deferred, then only the new launch once it relaunches', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'claude-opus-5-5', stopped: false });
    const reply = await postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' });

    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    const afterOldProcessHook = await listed(id);
    await pause(10);
    await sendHook(id, stop);
    await expect.poll(() => harness.launches.length).toBe(2);
    const afterRelaunch = await listed(id);
    await sendHook(id, preToolUse);
    const afterHookSeeingOnlyOldLines = await listed(id);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);
    const afterNewLaunchAnswered = await listed(id);

    expect(await reply.json()).toEqual({ status: 'deferred' });
    expect(afterOldProcessHook).toMatchObject({ model: 'claude-sonnet-5-5', resolvedModel: 'claude-opus-5-5' });
    expect(afterRelaunch).not.toHaveProperty('resolvedModel');
    expect(afterHookSeeingOnlyOldLines).not.toHaveProperty('resolvedModel');
    expect(afterNewLaunchAnswered).toMatchObject({ resolvedModel: 'claude-sonnet-5-5' });
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

  it('follows the transcript of the new CLI session after a /clear, whichever model the launch transcript holds', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPathOf(id), assistantLine({ model: 'claude-opus-5-4' }));
    const clearedCliSessionId = randomUUID();
    const clearedTranscriptPath = transcriptPathOf(clearedCliSessionId);
    writeFileSync(clearedTranscriptPath, assistantLine({ model: 'claude-opus-5-5' }));

    await sendHook(id, { hook_event_name: 'SessionStart', source: 'clear', session_id: clearedCliSessionId }, clearedTranscriptPath);
    await sendHook(id, preToolUse, clearedTranscriptPath);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5', cliVersion: CLI_VERSION });
  });

  it('records nothing on a session whose hook names the transcript of another session',async () => {
    const sessionA = await createSession('opus');
    const sessionB = await createSession('opus');
    writeFileSync(transcriptPathOf(sessionB), assistantLine({ model: 'claude-model-of-session-b' }));

    await sendHook(sessionA, preToolUse, transcriptPathOf(sessionB));

    expect(await listed(sessionA)).not.toHaveProperty('resolvedModel');
  });

  it('records nothing on a session that claims the id of another session in a SessionStart, then names its transcript',async () => {
    const sessionA = await createSession('opus');
    const sessionB = await createSession('opus');
    writeFileSync(transcriptPathOf(sessionB), assistantLine({ model: 'claude-model-of-session-b' }));

    await sendHook(sessionA, { hook_event_name: 'SessionStart', source: 'clear', session_id: sessionB }, transcriptPathOf(sessionB));
    await sendHook(sessionA, preToolUse, transcriptPathOf(sessionB));

    expect(await listed(sessionA)).not.toHaveProperty('resolvedModel');
  });

  it('records nothing on a session that claims the id of a closed session in a SessionStart, then names its transcript', async () => {
    const openSession = await createSession('opus');
    const closedSession = await createSession('opus');
    await postJson(`/api/sessions/${closedSession}/close`);
    writeFileSync(transcriptPathOf(closedSession), assistantLine({ model: 'claude-model-of-the-closed-session' }));

    await sendHook(openSession, { hook_event_name: 'SessionStart', session_id: closedSession }, transcriptPathOf(closedSession));
    await sendHook(openSession, preToolUse, transcriptPathOf(closedSession));

    expect(await listed(openSession)).not.toHaveProperty('resolvedModel');
  });

  it('records nothing on a session that claims a non-uuid CLI session id in a SessionStart, then names a transcript after it', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPathOf('foo'), assistantLine({ model: 'claude-model-of-foo' }));
    writeFileSync(transcriptPathOf(id), assistantLine({ model: 'claude-model-of-the-launch' }));

    await sendHook(id, { hook_event_name: 'SessionStart', session_id: 'foo' }, transcriptPathOf('foo'));
    await sendHook(id, preToolUse, transcriptPathOf('foo'));
    const afterForeignName = await listed(id);
    await sendHook(id, preToolUse, transcriptPathOf(id));

    expect(afterForeignName).not.toHaveProperty('resolvedModel');
    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-of-the-launch' });
  });

  it('records nothing on a session that claims the upper-cased id of another session in a SessionStart, then names its upper-cased transcript', async () => {
    const sessionA = await createSession('opus');
    const sessionB = await createSession('opus');
    writeFileSync(transcriptPathOf(sessionB), assistantLine({ model: 'claude-model-of-session-b' }));
    const upperCasedTranscriptOfB = transcriptPathOf(sessionB.toUpperCase());

    await sendHook(sessionA, { hook_event_name: 'SessionStart', session_id: sessionB.toUpperCase() }, upperCasedTranscriptOfB);
    await sendHook(sessionA, preToolUse, upperCasedTranscriptOfB);

    expect(await listed(sessionA)).not.toHaveProperty('resolvedModel');
  });

  it.each([
    { endedBy: 'closes', endSession: async (id: string) => { await postJson(`/api/sessions/${id}/close`); } },
    { endedBy: 'is relaunched', endSession: async (id: string) => { await postJson(`/api/sessions/${id}/close`); await postJson(`/api/sessions/${id}/reopen`); } },
  ])('records nothing on a session that claims a CLI session id that another session adopted and then $endedBy', async ({ endSession }) => {
    const sessionA = await createSession('opus');
    const sessionB = await createSession('opus');
    const adoptedCliSessionId = randomUUID();
    await sendHook(sessionB, { hook_event_name: 'SessionStart', source: 'clear', session_id: adoptedCliSessionId }, transcriptPathOf(adoptedCliSessionId));
    await endSession(sessionB);
    writeFileSync(transcriptPathOf(adoptedCliSessionId), assistantLine({ model: 'claude-model-of-the-adopted-id' }));

    await sendHook(sessionA, { hook_event_name: 'SessionStart', session_id: adoptedCliSessionId }, transcriptPathOf(adoptedCliSessionId));
    await sendHook(sessionA, preToolUse, transcriptPathOf(adoptedCliSessionId));

    expect(await listed(sessionA)).not.toHaveProperty('resolvedModel');
  });

  it('logs a hostile transcript name on one line, without its newline or escape characters', async () => {
    const id = await createSession('opus');
    const hostilePath = join(projectDirectory, `${randomUUID()}\nFORGED warn line \u001b[31m.jsonl`);
    writeFileSync(hostilePath, assistantLine({ model: 'claude-model-of-a-hostile-name' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendHook(id, preToolUse, hostilePath);
    const nameMismatchWarnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('does not match'));
    warnSpy.mockRestore();

    expect(nameMismatchWarnings).toHaveLength(1);
    expect(String(nameMismatchWarnings[0]![0])).not.toMatch(/[\n\u001b]/);
  });

  it('follows the launch transcript again after a permission-mode relaunch that follows a /clear', async () => {
    const id = await createSession('opus');
    const clearedCliSessionId = randomUUID();
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'clear', session_id: clearedCliSessionId }, transcriptPathOf(clearedCliSessionId));
    writeFileSync(transcriptPathOf(clearedCliSessionId), assistantLine({ model: 'claude-model-of-the-cleared-session', at: inOneSecond() }));
    writeFileSync(transcriptPathOf(id), assistantLine({ model: 'claude-model-of-the-launch', at: inOneSecond() }));

    const modeReply = (await (await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' })).json()) as { status: string };
    if (modeReply.status === 'deferred') await sendHook(id, stop, transcriptPathOf(clearedCliSessionId));
    await expect.poll(() => harness.launches.length).toBe(2);
    await sendHook(id, preToolUse, transcriptPathOf(clearedCliSessionId));
    const afterClearedName = await listed(id);
    await sendHook(id, preToolUse, transcriptPathOf(id));

    expect(afterClearedName).not.toHaveProperty('resolvedModel');
    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-of-the-launch' });
  });

  it('follows the launch transcript again after a close and reopen that follow a /clear', async () => {
    const id = await createSession('opus');
    const clearedCliSessionId = randomUUID();
    await sendHook(id, { hook_event_name: 'SessionStart', source: 'clear', session_id: clearedCliSessionId }, transcriptPathOf(clearedCliSessionId));
    writeFileSync(transcriptPathOf(clearedCliSessionId), assistantLine({ model: 'claude-model-of-the-cleared-session', at: inOneSecond() }));
    writeFileSync(transcriptPathOf(id), assistantLine({ model: 'claude-model-of-the-launch', at: inOneSecond() }));

    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);
    await sendHook(id, preToolUse, transcriptPathOf(clearedCliSessionId));
    const afterClearedName = await listed(id);
    await sendHook(id, preToolUse, transcriptPathOf(id));

    expect(afterClearedName).not.toHaveProperty('resolvedModel');
    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-model-of-the-launch' });
  });

  it('logs once per launch that a hook names a transcript that does not carry the session\'s CLI id, with ids and file name only', async () => {
    const id = await createSession('opus');
    const foreignName = `${randomUUID()}.jsonl`;
    const foreignPath = join(projectDirectory, foreignName);
    writeFileSync(foreignPath, assistantLine({ model: 'claude-model-of-a-foreign-name' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendHook(id, preToolUse, foreignPath);
    await sendHook(id, preToolUse, foreignPath);
    const nameMismatchWarnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('does not match'));
    warnSpy.mockRestore();

    expect(nameMismatchWarnings).toHaveLength(1);
    expect(String(nameMismatchWarnings[0]![0])).toContain(`transcript name does not match the session's CLI id: session ${id}, expected ${id}.jsonl, got "${foreignName}"`);
    expect(String(nameMismatchWarnings[0]![0])).not.toContain(projectDirectory);
  });

  it('logs the transcript name mismatch again after the session is relaunched', async () => {
    const id = await createSession('opus');
    await sendHook(id, { hook_event_name: 'SessionStart' });
    const foreignPath = transcriptPathOf(randomUUID());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendHook(id, preToolUse, foreignPath);
    await sendHook(id, stop, foreignPath);

    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    await expect.poll(() => harness.launches.length).toBe(2);
    await sendHook(id, preToolUse, foreignPath);
    await sendHook(id, preToolUse, foreignPath);
    const nameMismatchWarnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('does not match'));
    warnSpy.mockRestore();

    expect(nameMismatchWarnings).toHaveLength(2);
  });

  it('records nothing from a hard link in the projects directory to a file outside it', async () => {
    const id = await createSession('opus');
    const foreignFile = join(mkdtempSync(join(tmpdir(), 'of-outside-')), 'foreign.jsonl');
    writeFileSync(foreignFile, assistantLine({ model: 'claude-model-of-a-foreign-file' }));
    const hardLinkPath = join(projectDirectory, 'hardlink.jsonl');
    linkSync(foreignFile, hardLinkPath);

    await sendHook(id, preToolUse, hardLinkPath);

    expect(await listed(id)).not.toHaveProperty('resolvedModel');
  });

  it('records nothing from a transcript named after the session that is a symlink to another session\'s transcript', async () => {
    const sessionA = await createSession('opus');
    const sessionB = await createSession('opus');
    writeFileSync(transcriptPathOf(sessionB), assistantLine({ model: 'claude-model-of-session-b' }));
    symlinkSync(transcriptPathOf(sessionB), transcriptPathOf(sessionA));

    await sendHook(sessionA, preToolUse, transcriptPathOf(sessionA));

    expect(await listed(sessionA)).not.toHaveProperty('resolvedModel');
  });

  describe.each([
    { relaunchedBy: 'a model switch', relaunch: (id: string) => postJson(`/api/sessions/${id}/model`, { model: 'claude-sonnet-5-5' }) },
    { relaunchedBy: 'the same alias re-applied', relaunch: (id: string) => postJson(`/api/sessions/${id}/model`, { model: 'opus' }) },
  ])('a connected client after $relaunchedBy relaunches the session',({ relaunch }) => {
    it('receives one session.updated without the resolved model the old launch recorded', async () => {
      const id = await createSession('opus');
      const { ticket } = (await (await postJson('/api/ws-ticket')).json()) as { ticket: string };
      const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
      const received: { type: string; session?: ListedSession }[] = [];
      ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
      await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
      await sendHook(id, { hook_event_name: 'SessionStart' });
      writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
      await sendHook(id, preToolUse);
      await sendHook(id, stop);

      await relaunch(id);
      await expect.poll(() => harness.launches.length).toBe(2);
      await pause(50);
      ws.close();

      const updates = received.filter((event) => event.type === 'session.updated' && event.session?.id === id);
      expect(updates).toHaveLength(2);
      expect(updates[0]!.session).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
      expect(updates[1]!.session).not.toHaveProperty('resolvedModel');
    });
  });
});

describe('resolved model recording when the CLI flushes its answer to the transcript just after the Stop hook', () => {
  it('shows the resolved model and CLI version of a session whose assistant line lands after its Stop hook returned', async () => {
    const id = await createSession('opus');
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    await sendHook(id, stop);

    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));

    await expect.poll(async () => (await listed(id)).resolvedModel, { timeout: 3000 }).toBe('claude-opus-5-5');
    expect(await listed(id)).toMatchObject({ cliVersion: CLI_VERSION });
  });

  it('gives up after that one retry: a line landing later still waits for the next hook', async () => {
    const id = await createSession('opus');
    await sendHook(id, stop);
    await pause(800);

    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await pause(1000);
    const beforeNextHook = await listed(id);
    await sendHook(id, preToolUse);

    expect(beforeNextHook).not.toHaveProperty('resolvedModel');
    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
  });
});

describe('model drift between launches that resolve the same requested model', () => {
  const resolveOn = async (requestedModel: string | undefined, resolvedModel: string) => {
    const id = await createSession(requestedModel);
    writeFileSync(transcriptPath, assistantLine({ model: resolvedModel }));
    await sendHook(id, preToolUse);
    return id;
  };
  const captureDriftWarnings = () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return {
      lines: () => warnSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('model drift')),
      stop: () => warnSpy.mockRestore(),
    };
  };
  const relaunchWithAlias = async (id: string, alias: string, expectedLaunches: number) => {
    await postJson(`/api/sessions/${id}/model`, { model: alias });
    await expect.poll(() => harness.launches.length).toBe(expectedLaunches);
  };

  it('shows the previous id on a second session whose alias resolves to a different id, and logs one warning naming both ids', async () => {
    const first = await resolveOn('opus', 'claude-opus-5-5');
    const warnings = captureDriftWarnings();

    const second = await resolveOn('opus', 'claude-opus-5-6');
    const lines = warnings.lines();
    warnings.stop();

    expect(await listed(second)).toMatchObject({ resolvedModel: 'claude-opus-5-6', modelDriftedFrom: 'claude-opus-5-5' });
    expect(await listed(first)).not.toHaveProperty('modelDriftedFrom');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"opus" resolves to claude-opus-5-6, previously claude-opus-5-5 (session ${second}, previous session ${first}, cli ${CLI_VERSION})`);
  });

  it('shows no drift and logs nothing when a second session resolves the same alias to the same id', async () => {
    await resolveOn('opus', 'claude-opus-5-5');
    const warnings = captureDriftWarnings();

    const second = await resolveOn('opus', 'claude-opus-5-5');
    const lines = warnings.lines();
    warnings.stop();

    expect(await listed(second)).not.toHaveProperty('modelDriftedFrom');
    expect(lines).toHaveLength(0);
  });

  it('compares a second session against the most recently created session that resolved the alias', async () => {
    await resolveOn('opus', 'claude-opus-5-4');
    await pause(5);
    await resolveOn('opus', 'claude-opus-5-5');
    await pause(5);

    const third = await resolveOn('opus', 'claude-opus-5-5');

    expect(await listed(third)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows the session\'s own previous id when a relaunch of the same alias resolves to a new id', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: true });
    const warnings = captureDriftWarnings();

    await relaunchWithAlias(id, 'opus', 2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);
    const lines = warnings.lines();
    warnings.stop();

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-6', modelDriftedFrom: 'claude-opus-5-5' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`previously claude-opus-5-5 (session ${id}, same session relaunched, cli ${CLI_VERSION})`);
  });

  it('shows no drift when a relaunch of the same alias resolves to the same id', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: true });

    await relaunchWithAlias(id, 'opus', 2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-5' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('never drifts a session against a session of another alias, nor against its own id from before a switch to another alias', async () => {
    await resolveOn('opus', 'claude-opus-5-5');
    const sonnet = await resolveOn('sonnet', 'claude-sonnet-5-5');
    const switched = await sessionWithRecordedOpus({ requestedModel: 'haiku', stopped: true });

    await relaunchWithAlias(switched, 'sonnet', 4);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(switched, preToolUse);

    expect(await listed(sonnet)).not.toHaveProperty('modelDriftedFrom');
    expect(await listed(switched)).toMatchObject({ resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(switched)).not.toHaveProperty('modelDriftedFrom');
  });

  it('clears a drift flag when a permission-mode relaunch of the session resolves to the same id again', async () => {
    await resolveOn('opus', 'claude-opus-5-5');
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    const afterLaunchOne = await listed(id);

    await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' });
    await expect.poll(() => harness.launches.length).toBe(3);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(afterLaunchOne).toMatchObject({ modelDriftedFrom: 'claude-opus-5-5' });
    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-6' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('applies the same rule to sessions launched without a model', async () => {
    await resolveOn(undefined, 'claude-default-5-5');
    await resolveOn('opus', 'claude-opus-5-5');
    const warnings = captureDriftWarnings();

    const withoutModel = await resolveOn(undefined, 'claude-default-5-6');
    const lines = warnings.lines();
    warnings.stop();

    expect(await listed(withoutModel)).toMatchObject({ resolvedModel: 'claude-default-5-6', modelDriftedFrom: 'claude-default-5-5' });
    expect(lines).toHaveLength(1);
  });

  it('streams the drift in the session.updated that carries the resolved model', async () => {
    await resolveOn('opus', 'claude-opus-5-5');
    const id = await createSession('opus');
    const { ticket } = (await (await postJson('/api/ws-ticket')).json()) as { ticket: string };
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const received: { type: string; session?: ListedSession }[] = [];
    ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6' }));

    await sendHook(id, preToolUse);
    await pause(50);
    ws.close();

    const updates = received.filter((event) => event.type === 'session.updated' && event.session?.id === id);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.session).toMatchObject({ resolvedModel: 'claude-opus-5-6', modelDriftedFrom: 'claude-opus-5-5' });
  });

  it('forgets a same-alias relaunch closed before its recording, so a reopen compares with the other sessions', async () => {
    await resolveOn('opus', 'claude-opus-5-4');
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    await relaunchWithAlias(id, 'opus', 3);
    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);
    await expect.poll(() => harness.launches.length).toBe(4);

    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-4', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-4' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows the drift against the latest session that recorded a model, skipping a newer session that never recorded one', async () => {
    await resolveOn('opus', 'claude-opus-5-5');
    await pause(5);
    await createSession('opus');
    await pause(5);

    const third = await resolveOn('opus', 'claude-opus-5-6');

    expect(await listed(third)).toMatchObject({ modelDriftedFrom: 'claude-opus-5-5' });
  });

  it('compares an alias rolled back after a detour through another alias with the other sessions', async () => {
    await resolveOn('opus', 'claude-opus-5-5');
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    await relaunchWithAlias(id, 'sonnet', 3);
    await sendHook(id, { hook_event_name: 'SessionStart' });
    await sendHook(id, stop);
    await relaunchWithAlias(id, 'opus', 4);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-6', modelDriftedFrom: 'claude-opus-5-5' });
  });
});

describe('model drift never blames a deliberate model switch', () => {
  const resolveOn = async (requestedModel: string, resolvedModel: string) => {
    const id = await createSession(requestedModel);
    writeFileSync(transcriptPath, assistantLine({ model: resolvedModel }));
    await sendHook(id, preToolUse);
    return id;
  };
  const waitForLaunches = (count: number) => expect.poll(() => harness.launches.length).toBeGreaterThanOrEqual(count);

  it('shows no drift after a model switch requested twice while the first one still waits for the session to go idle', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: false });

    await postJson(`/api/sessions/${id}/model`, { model: 'sonnet' });
    await postJson(`/api/sessions/${id}/model`, { model: 'sonnet' });
    await pause(10);
    await sendHook(id, stop);
    await waitForLaunches(2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows no drift after a model switch requested twice while the first one is relaunching', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: true });

    await Promise.all([postJson(`/api/sessions/${id}/model`, { model: 'sonnet' }), postJson(`/api/sessions/${id}/model`, { model: 'sonnet' })]);
    await waitForLaunches(2);
    await pause(50);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows no drift when the daemon restarts between a model switch and its relaunch', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: false });
    await postJson(`/api/sessions/${id}/model`, { model: 'sonnet' });

    await server.close();
    await bootDaemon();
    await daemonSessions.resumeAll();
    await waitForLaunches(2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows no drift on a new session of the alias another session is switching to, while that switch waits', async () => {
    const switching = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: false });
    await postJson(`/api/sessions/${switching}/model`, { model: 'sonnet' });

    const fresh = await resolveOn('sonnet', 'claude-sonnet-5-5');

    expect(await listed(fresh)).toMatchObject({ resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(fresh)).not.toHaveProperty('modelDriftedFrom');
  });

  it('still shows the drift of a same-alias relaunch whose old launch recorded only while the relaunch was deferred', async () => {
    const id = await createSession('opus');
    await sendHook(id, { hook_event_name: 'UserPromptSubmit' });
    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await pause(10);
    await sendHook(id, stop);
    await waitForLaunches(2);

    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-6', modelDriftedFrom: 'claude-opus-5-5' });
  });
});

describe('model drift hostile cases', () => {
  const resolveOn = async (requestedModel: string | undefined, resolvedModel: string) => {
    const id = await createSession(requestedModel);
    writeFileSync(transcriptPath, assistantLine({ model: resolvedModel }));
    await sendHook(id, preToolUse);
    return id;
  };
  const waitForLaunches = (count: number) => expect.poll(() => harness.launches.length).toBeGreaterThanOrEqual(count);
  afterEach(() => { vi.useRealTimers(); });

  it('shows no drift on a new session of the target alias, nor on the switching session, when the old launch records only after a deferred switch to another alias', async () => {
    const switching = await createSession('opus');
    const switchingTranscript = transcriptPath;
    await sendHook(switching, { hook_event_name: 'UserPromptSubmit' });
    await postJson(`/api/sessions/${switching}/model`, { model: 'sonnet' });
    writeFileSync(switchingTranscript, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(switching, preToolUse, switchingTranscript);

    const fresh = await resolveOn('sonnet', 'claude-sonnet-5-5');
    await sendHook(switching, stop, switchingTranscript);
    await waitForLaunches(3);
    appendFileSync(switchingTranscript, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(switching, preToolUse, switchingTranscript);

    expect(await listed(fresh)).not.toHaveProperty('modelDriftedFrom');
    expect(await listed(switching)).toMatchObject({ resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(switching)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows the drift against the session created just before it when a third session is created in the same millisecond as the two others', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    await resolveOn('opus', 'claude-opus-5-4');
    await resolveOn('opus', 'claude-opus-5-5');

    const third = await resolveOn('opus', 'claude-opus-5-6');

    expect(await listed(third)).toMatchObject({ modelDriftedFrom: 'claude-opus-5-5' });
  });

  it('shows no drift on a switch to another alias after the same alias was re-applied, whatever that relaunch recorded', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: true });
    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    await waitForLaunches(2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);

    await postJson(`/api/sessions/${id}/model`, { model: 'sonnet' });
    await waitForLaunches(3);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows the own previous id of a session launched without a model when a permission-mode relaunch resolves a new id', async () => {
    const id = await createSession(undefined);
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-default-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);

    await postJson(`/api/sessions/${id}/permission-mode`, { mode: 'plan' });
    await waitForLaunches(2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-default-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-default-5-6', modelDriftedFrom: 'claude-default-5-5' });
  });

  it('shows no drift after a deferred switch abandoned by close and reopen when the reopened launch resolves the new alias', async () => {
    const id = await sessionWithRecordedOpus({ requestedModel: 'opus', stopped: false });
    await postJson(`/api/sessions/${id}/model`, { model: 'sonnet' });

    await postJson(`/api/sessions/${id}/close`);
    await postJson(`/api/sessions/${id}/reopen`);
    await waitForLaunches(2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows the drift of each session against the one created just before it in a burst created within one millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const resolvedIds = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-6', 'claude-opus-5-6', 'claude-opus-5-7'];
    const sessions: string[] = [];
    for (const resolvedId of resolvedIds) sessions.push(await resolveOn('opus', resolvedId));

    const drifts = await Promise.all(sessions.map(async (id) => (await listed(id)).modelDriftedFrom));

    expect(drifts).toEqual([undefined, undefined, 'claude-opus-5-5', undefined, 'claude-opus-5-6']);
  });

  it('shows no drift on an unknown alias against a session of the default model', async () => {
    await resolveOn(undefined, 'claude-default-5-5');

    const unknownAlias = await resolveOn('no-such-alias', 'claude-default-5-6');

    expect(await listed(unknownAlias)).not.toHaveProperty('modelDriftedFrom');
  });
});

describe('the session a drift is compared with', () => {
  const resolveOn = async (requestedModel: string, resolvedModel: string) => {
    const id = await createSession(requestedModel);
    writeFileSync(transcriptPath, assistantLine({ model: resolvedModel }));
    await sendHook(id, preToolUse);
    return id;
  };
  afterEach(() => { vi.useRealTimers(); });

  const waitForLaunches = (count: number) => expect.poll(() => harness.launches.length).toBeGreaterThanOrEqual(count);

  it('shows no drift when a session returns to an alias after a detour, since its last run under that alias resolved the same id', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    await waitForLaunches(2);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    await postJson(`/api/sessions/${id}/model`, { model: 'sonnet' });
    await waitForLaunches(3);
    appendFileSync(transcriptPath, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    await waitForLaunches(4);

    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ model: 'opus', resolvedModel: 'claude-opus-5-6' });
    expect(await listed(id)).not.toHaveProperty('modelDriftedFrom');
  });

  it('compares a session with the latest session of the alias even when created after: documented reversed-drift ceiling', async () => {
    const earlier = await createSession('opus');
    const earlierTranscript = transcriptPath;
    await pause(5);
    await resolveOn('opus', 'claude-opus-5-4');

    writeFileSync(earlierTranscript, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(earlier, preToolUse, earlierTranscript);

    expect(await listed(earlier)).toMatchObject({ resolvedModel: 'claude-opus-5-5', modelDriftedFrom: 'claude-opus-5-4' });
  });

  it('shows no drift on a session switched to an alias whose latest session already resolves the same id', async () => {
    await resolveOn('sonnet', 'claude-sonnet-5-0');
    await pause(5);
    const switching = await createSession('opus');
    const switchingTranscript = transcriptPath;
    await sendHook(switching, preToolUse, switchingTranscript);
    await sendHook(switching, stop, switchingTranscript);
    await pause(5);
    await resolveOn('sonnet', 'claude-sonnet-5-5');

    await postJson(`/api/sessions/${switching}/model`, { model: 'sonnet' });
    await waitForLaunches(4);
    writeFileSync(switchingTranscript, assistantLine({ model: 'claude-sonnet-5-5', at: inOneSecond() }));
    await sendHook(switching, preToolUse, switchingTranscript);

    expect(await listed(switching)).toMatchObject({ resolvedModel: 'claude-sonnet-5-5' });
    expect(await listed(switching)).not.toHaveProperty('modelDriftedFrom');
  });

  it('shows the drift from the id resolved before an intermediate same-alias relaunch that recorded nothing', async () => {
    const id = await createSession('opus');
    writeFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-5' }));
    await sendHook(id, preToolUse);
    await sendHook(id, stop);
    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    await waitForLaunches(2);
    await sendHook(id, stop);
    await pause(20);
    await postJson(`/api/sessions/${id}/model`, { model: 'opus' });
    await waitForLaunches(3);

    appendFileSync(transcriptPath, assistantLine({ model: 'claude-opus-5-6', at: inOneSecond() }));
    await sendHook(id, preToolUse);

    expect(await listed(id)).toMatchObject({ resolvedModel: 'claude-opus-5-6', modelDriftedFrom: 'claude-opus-5-5' });
  });

  it('compares a session with the last one created when several were created in the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    await resolveOn('opus', 'claude-opus-5-4');
    await resolveOn('opus', 'claude-opus-5-5');

    const third = await resolveOn('opus', 'claude-opus-5-5');

    expect(await listed(third)).not.toHaveProperty('modelDriftedFrom');
  });
});
