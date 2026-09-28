import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let bus: EventBus;
let sessions: SessionService;
let approvals: ApprovalService;
let hookToken: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
  const session = await sessions.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
  hookToken = (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(session.id) as { hook_token: string }).hook_token;
});
afterEach(() => server.close());

const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const APPROVAL_POLL_INTERVAL_MS = 5;

const decideOnceRequested = async (behavior: 'allow' | 'deny') => {
  await vi.waitFor(() => expect(approvals.listPending()).toHaveLength(1), { interval: APPROVAL_POLL_INTERVAL_MS });
  approvals.decide({ approvalId: approvals.listPending()[0]!.id, behavior });
};

describe('POST /hooks/:token', () => {
  it('moves the session to idle on SessionStart', async () => {
    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'SessionStart' });
    expect(res.status).toBe(200);
    expect(sessions.list()[0]!.state).toBe('idle');
  });

  it('accepts the CLI stdin payload the SessionStart command hook forwards, including its source', async () => {
    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', transcript_path: '/t.jsonl', cwd: '/tmp', hook_event_name: 'SessionStart', source: 'startup' });
    expect(res.status).toBe(200);
    expect(sessions.list()[0]!.state).toBe('idle');
  });

  it('leaves the session state alone on a SessionStart fired by a context compaction', async () => {
    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', transcript_path: '/t.jsonl', cwd: '/tmp', hook_event_name: 'SessionStart', source: 'compact' });
    expect(res.status).toBe(200);
    expect(sessions.list()[0]!.state).toBe('starting');
  });

  it('unknown token is a no-op 200', async () => {
    const res = await post('/hooks/nope', { session_id: 'c', hook_event_name: 'Stop' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('a closed session\'s hook token, never rotated by this build (a pre-patch upgrade row), is a no-op 200 — same as an unknown token', async () => {
    const legacyToken = 'legacy-hook-token-that-predates-the-rotation-fix';
    db.prepare(
      `INSERT INTO sessions (id, name, emoji, directory, worktree, model, parent_id, role, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, project_id, created_at, closed_at, exit_code)
       VALUES (?, 'legacy', '🤖', '/tmp', NULL, NULL, NULL, NULL, 'fake', 'closed', ?, ?, 'legacy-mcp-token', NULL, NULL, NULL, ?, ?, 0)`,
    ).run('legacy-closed-session', new Date().toISOString(), legacyToken, new Date().toISOString(), new Date().toISOString());
    await sessions.resumeAll(); // boots like main.ts — resumeAll never touches a closed row

    const res = await post(`/hooks/${legacyToken}`, { session_id: 'c', hook_event_name: 'Stop' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('answers an unknown token without reading the body, even when it is huge', async () => {
    const oversizedBody = { session_id: 'c', hook_event_name: 'Stop', pad: 'x'.repeat(2 * 1024 * 1024) };
    const res = await post('/hooks/nope', oversizedBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('rejects a body over 1 MiB for a known token with 413', async () => {
    const oversizedBody = { session_id: 'c', hook_event_name: 'Stop', pad: 'x'.repeat(2 * 1024 * 1024) };
    const res = await post(`/hooks/${hookToken}`, oversizedBody);
    expect(res.status).toBe(413);
  });

  it('PermissionRequest waits for the decision and answers allow', async () => {
    const pending = post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await decideOnceRequested('allow');
    const body = await (await pending).json();
    expect(body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(sessions.list()[0]!.state).toBe('generating');
  });

  it('PermissionRequest answers deny with a message', async () => {
    const pending = post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    await decideOnceRequested('deny');
    const body = await (await pending).json();
    expect(body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'denied in OpenFleet' } } });
  });

  it('PermissionRequest answers with an empty body when nobody decides in time, falling back to the CLI prompt', async () => {
    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    expect(await res.json()).toEqual({});
  });

  it('a hook posted with the pre-restart hook token is a no-op once resume has rotated it', async () => {
    const staleHookToken = hookToken;
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 5000 });
    await restarted.resumeAll();

    const res = await post(`/hooks/${staleHookToken}`, { session_id: 'c', hook_event_name: 'SessionStart' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(sessions.list()[0]!.state).not.toBe('idle');
    await restarted.closeAll();
  });
});
