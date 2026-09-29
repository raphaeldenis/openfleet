import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalError, ApprovalService } from '../governance/approvalService.js';
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

  it('logs a forced 500 on a known hook token with the route pattern, never any part of the raw token', async () => {
    const applyInputSpy = vi.spyOn(sessions, 'applyInput').mockImplementation(() => {
      throw new Error('boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'SessionStart' });

    expect(res.status).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [line] = consoleErrorSpy.mock.calls[0]!;
    expect(line as string).not.toContain(hookToken);
    expect(line as string).toContain('/hooks/:token');
    applyInputSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // Both tests below need an approval that would NOT resolve on its own within the test's lifetime, so a
  // long-lived timeoutMs (far past vitest's own per-test timeout) rules out the pre-existing timeout
  // fallback from masking a broken close/relaunch expiry as a false green — only the AUD-07 code path
  // being tested can resolve these in time. Self-contained: the shared beforeEach's approvals uses a
  // short 100ms timeoutMs for its own (unrelated) fallback test.
  async function setupLongTimeoutFixture() {
    const localDb = openDatabase(':memory:');
    const localBus = new EventBus();
    const localSessions = new SessionService({ db: localDb, bus: localBus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const localApprovals = new ApprovalService({ db: localDb, bus: localBus, timeoutMs: 60_000 });
    const managerRepo = new ManagerRepository(localDb);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions: localSessions, bus: localBus });
    const managers = new ManagerService({ managers: managerRepo, sessions: localSessions, bus: localBus, scheduler: pulseScheduler });
    const localServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: localSessions, approvals: localApprovals, managers, pulseScheduler, bus: localBus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
    const session = await localSessions.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    const localHookToken = (localDb.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(session.id) as { hook_token: string }).hook_token;
    const localPost = (path: string, body: unknown) => fetch(`${localServer.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { sessions: localSessions, approvals: localApprovals, server: localServer, hookToken: localHookToken, post: localPost, sessionId: session.id };
  }

  it('closing a gated session expires its pending approval, answering the waiting hook with the ask fallback instead of leaving it hanging (AUD-07)', async () => {
    const fx = await setupLongTimeoutFixture();
    try {
      const pending = fx.post(`/hooks/${fx.hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
      await vi.waitFor(() => expect(fx.approvals.listPending()).toHaveLength(1), { interval: APPROVAL_POLL_INTERVAL_MS });
      const approvalId = fx.approvals.listPending()[0]!.id;

      await fx.sessions.close(fx.sessionId);

      const body = await (await pending).json();
      expect(body).toEqual({});
      expect(fx.approvals.listPending()).toEqual([]);
      expect(() => fx.approvals.decide({ approvalId, behavior: 'allow' })).toThrow(ApprovalError);
    } finally {
      await fx.server.close();
    }
  });

  it('relaunching a session (a deferred model change released once its gate clears) expires any approval still pending for it, instead of leaving that one hanging for the daemon\'s full timeout (AUD-07)', async () => {
    const fx = await setupLongTimeoutFixture();
    try {
      await fx.post(`/hooks/${fx.hookToken}`, { session_id: 'c', hook_event_name: 'SessionStart' });

      // Two tool calls request approval close together; the first gates the session, the second piles up
      // pending behind it — Claude Code can fire PermissionRequest for parallel tool_use blocks in one turn.
      const gating = fx.post(`/hooks/${fx.hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
      await vi.waitFor(() => expect(fx.approvals.listPending()).toHaveLength(1), { interval: APPROVAL_POLL_INTERVAL_MS });
      const gatingApprovalId = fx.approvals.listPending()[0]!.id;
      const orphaned = fx.post(`/hooks/${fx.hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls -la' } });
      await vi.waitFor(() => expect(fx.approvals.listPending()).toHaveLength(2), { interval: APPROVAL_POLL_INTERVAL_MS });
      const orphanedApprovalId = fx.approvals.listPending().find((a) => a.id !== gatingApprovalId)!.id;

      // The session is gated (not deliverable), so this defers instead of relaunching yet.
      expect(fx.sessions.updateModel(fx.sessionId, 'claude-opus-5-5').status).toBe('deferred');

      // Deciding the gating approval frees the turn; Stop then makes the session deliverable again, which
      // releases the deferred relaunch while the orphaned approval is still sitting pending.
      fx.approvals.decide({ approvalId: gatingApprovalId, behavior: 'allow' });
      await gating;
      await fx.post(`/hooks/${fx.hookToken}`, { session_id: 'c', hook_event_name: 'Stop' });

      const orphanedBody = await (await orphaned).json();
      expect(orphanedBody).toEqual({});
      expect(fx.approvals.listPending()).toEqual([]);
      expect(() => fx.approvals.decide({ approvalId: orphanedApprovalId, behavior: 'allow' })).toThrow(ApprovalError);
    } finally {
      await fx.server.close();
    }
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
