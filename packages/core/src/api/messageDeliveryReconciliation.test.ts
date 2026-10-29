import { createHash, randomUUID } from 'node:crypto';
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

const TURN_START_TIMEOUT_MS = 40;
const SETTLE_AFTER_TIMEOUTS_MS = TURN_START_TIMEOUT_MS * 8;
const MESSAGE_BODY = 'synthetic message body for the reconciler';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let db: ReturnType<typeof openDatabase>;
let projectDirectory: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'of-reconciler-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  projectDirectory = join(configDir, 'projects', 'proj');
  mkdirSync(projectDirectory, { recursive: true });
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0, turnStartTimeoutMs: TURN_START_TIMEOUT_MS });
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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const hookTokenOf = async (id: string) => ((await (await api(`/api/sessions/${id}/tokens`)).json()) as { hookToken: string }).hookToken;

const sendHook = async (id: string, event: Record<string, unknown>) => {
  const token = await hookTokenOf(id);
  return fetch(`${server.url}/hooks/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: id, transcript_path: join(projectDirectory, `${id}.jsonl`), ...event }),
  });
};

const idleSessionReportingHooks = async () => {
  const created = (await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake' })).json()) as { id: string };
  harness.markPrompted(created.id);
  await sendHook(created.id, { hook_event_name: 'SessionStart' });
  return created.id;
};

const sendMessage = (sessionId: string, messageId?: string) => postJson(`/api/sessions/${sessionId}/messages`, { body: MESSAGE_BODY, messageId });
const submittedBodies = () => harness.handles[0]!.submitted;

// A CLI that starts a turn: it posts the UserPromptSubmit hook of what it just took.
const cliReportingItsTurns = (sessionId: string) => {
  harness.handles[0]!.onSubmit = (body) => { void sendHook(sessionId, { hook_event_name: 'UserPromptSubmit', user_prompt: body }); };
};

const userLine = (text: string) => `${JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

describe('delivery reconciliation of a message typed into a session', () => {
  it('types the message again, once, when the target stayed idle and its digest never appeared', async () => {
    const sessionId = await idleSessionReportingHooks();

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual([MESSAGE_BODY, MESSAGE_BODY]);
  });

  it('never types the message again when the CLI reported the turn of its digest', async () => {
    const sessionId = await idleSessionReportingHooks();
    cliReportingItsTurns(sessionId);

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual([MESSAGE_BODY]);
  });

  it('never types the message again when its digest is in the target transcript although no hook reported it', async () => {
    const sessionId = await idleSessionReportingHooks();
    writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), userLine(MESSAGE_BODY));

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual([MESSAGE_BODY]);
  });

  it('types the message again when only another text sits in the target transcript', async () => {
    const sessionId = await idleSessionReportingHooks();
    writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), userLine('some other prompt'));

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual([MESSAGE_BODY, MESSAGE_BODY]);
  });

  it('absorbs a probe that replays the same message id: nothing is typed because of it', async () => {
    const sessionId = await idleSessionReportingHooks();
    cliReportingItsTurns(sessionId);
    const messageId = randomUUID();

    await sendMessage(sessionId, messageId);
    const probe = await sendMessage(sessionId, messageId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(probe.status).toBe(200);
    expect(submittedBodies()).toEqual([MESSAGE_BODY]);
  });

  it('types a local slash command once: it starts no turn, so its silence proves nothing', async () => {
    const sessionId = await idleSessionReportingHooks();

    await postJson(`/api/sessions/${sessionId}/messages`, { body: '  /compact' });
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual(['  /compact']);
  });

  it('types the message again in a session that dropped it although another session took the identical prompt', async () => {
    const droppingSessionId = await idleSessionReportingHooks();
    const takingSessionId = await idleSessionReportingHooks();
    harness.handles[0]!.onSubmit = () => undefined;
    harness.handles[1]!.onSubmit = (body) => { void sendHook(takingSessionId, { hook_event_name: 'UserPromptSubmit', user_prompt: body }); };

    await sendMessage(droppingSessionId);
    await sendMessage(takingSessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(harness.handles[0]!.submitted).toEqual([MESSAGE_BODY, MESSAGE_BODY]);
    expect(harness.handles[1]!.submitted).toEqual([MESSAGE_BODY]);
  });

  it('types the second of two identical messages again when the CLI dropped it, although the first was taken', async () => {
    const sessionId = await idleSessionReportingHooks();
    writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), '');
    cliReportingItsTurns(sessionId);
    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);
    await sendHook(sessionId, { hook_event_name: 'Stop' });
    await pause(SETTLE_AFTER_TIMEOUTS_MS);
    harness.handles[0]!.onSubmit = () => undefined;

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual([MESSAGE_BODY, MESSAGE_BODY, MESSAGE_BODY]);
  });

  it('types the second of two identical messages again when only the first sits in the transcript', async () => {
    const sessionId = await idleSessionReportingHooks();
    const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    const firstTakenLine = JSON.stringify({ type: 'user', isSidechain: false, timestamp: secondsAgo(60), message: { role: 'user', content: MESSAGE_BODY } });
    writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), `${firstTakenLine}\n`);

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual([MESSAGE_BODY, MESSAGE_BODY]);
  });

  it('types a multi-line message once when the CLI reports it with normalized line breaks', async () => {
    const sessionId = await idleSessionReportingHooks();
    writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), '');
    harness.handles[0]!.onSubmit = (body) => { void sendHook(sessionId, { hook_event_name: 'UserPromptSubmit', user_prompt: body.replace(/\r\n?/g, '\n') }); };

    await postJson(`/api/sessions/${sessionId}/messages`, { body: 'line one\r\nline two' });
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual(['line one\r\nline two']);
  });

  it('types a multi-line message once when only the transcript holds it with normalized line breaks', async () => {
    const sessionId = await idleSessionReportingHooks();
    writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), userLine('line one\nline two'));

    await postJson(`/api/sessions/${sessionId}/messages`, { body: 'line one\r\nline two' });
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    expect(submittedBodies()).toEqual(['line one\r\nline two']);
  });

  it('stores only the SHA-256 of a submitted prompt, keyed by the CLI session id', async () => {
    const sessionId = await idleSessionReportingHooks();
    cliReportingItsTurns(sessionId);

    await sendMessage(sessionId);
    await pause(SETTLE_AFTER_TIMEOUTS_MS);

    const promptRows = db.prepare('SELECT * FROM prompt_digests').all() as { cli_session_id: string; digest: string }[];
    const deliveryRows = db.prepare('SELECT * FROM message_deliveries').all();
    expect(promptRows.map((row) => ({ cli_session_id: row.cli_session_id, digest: row.digest }))).toEqual([{ cli_session_id: sessionId, digest: sha256(MESSAGE_BODY) }]);
    expect(JSON.stringify([...promptRows, ...deliveryRows])).not.toContain(MESSAGE_BODY);
  });
});
