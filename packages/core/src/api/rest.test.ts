import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_MODES } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let sessions: SessionService;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });

describe('REST', () => {
  it('answers /health with no auth required, for CI/e2e readiness probes', async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers a CORS preflight so the desktop shell can call the daemon cross-origin', async () => {
    const res = await fetch(`${server.url}/api/sessions`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:1420', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('allows the desktop shell origin on real responses so the browser accepts the fetch', async () => {
    const res = await fetch(`${server.url}/api/sessions`, { headers: { authorization: 'Bearer admin', origin: 'http://localhost:1420' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
  });

  it('sends no CORS headers for an origin outside the allowlist', async () => {
    const res = await fetch(`${server.url}/api/sessions`, { headers: { authorization: 'Bearer admin', origin: 'http://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a missing bearer token', async () => {
    const res = await fetch(`${server.url}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await fetch(`${server.url}/api/sessions`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('returns the resolved model table on GET /api/models', async () => {
    const res = await api('/api/models');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_MODEL_TABLE);
  });

  it('refuses GET /api/models without a bearer token', async () => {
    const res = await fetch(`${server.url}/api/models`);
    expect(res.status).toBe(401);
  });

  it('rejects a body over 1 MiB on a protected route with 413', async () => {
    const oversizedBody = JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', pad: 'x'.repeat(2 * 1024 * 1024) });
    const res = await api('/api/sessions', { method: 'POST', body: oversizedBody });
    expect(res.status).toBe(413);
  });

  it('creates and lists sessions', async () => {
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Gimli', harness: 'fake' }) });
    expect(created.status).toBe(201);
    const list = await (await api('/api/sessions')).json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Gimli');
  });

  it('400s a session create carrying the undocumented "default" permission mode alias, not a 500', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', permissionMode: 'default' }) });
    expect(res.status).toBe(400);
  });

  it('400s a session create carrying a bogus permission mode, not a 500', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', permissionMode: 'yolo' }) });
    expect(res.status).toBe(400);
  });

  it.each(PERMISSION_MODES)('201s a session create carrying the documented permission mode "%s" and passes it through to the harness launch', async (mode) => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', permissionMode: mode }) });
    expect(res.status).toBe(201);
    expect(harness.launches[0]!.permissionMode).toBe(mode);
  });

  it('sends raw input to the pty', async () => {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${session.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'y' }) });
    expect(harness.handles[0]!.written).toEqual(['y']);
  });

  it('returns recent output for a session', async () => {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    harness.handles[0]!.emitData('hello ');
    harness.handles[0]!.emitData('world');
    const res = await api(`/api/sessions/${session.id}/output`);
    expect(await res.json()).toEqual({ output: 'hello world' });
  });

  it('returns the hook token for a session', async () => {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const body = await (await api(`/api/sessions/${session.id}/tokens`)).json();
    expect(body.hookToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('injects fake output onto a fake-harness session pty', async () => {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${session.id}/fake-output`, { method: 'POST', body: JSON.stringify({ data: 'hello from pty' }) });
    const output = await (await api(`/api/sessions/${session.id}/output`)).json();
    expect(output.output).toBe('hello from pty');
  });

  it('rejects fake-output on a non-fake harness session with 404', async () => {
    const claudeCliStub = {
      id: 'claude-cli' as const,
      start: () => ({ write: () => {}, typeMessage: () => {}, resize: () => {}, kill: () => {}, onData: () => () => {}, onExit: () => () => {} }),
    };
    const stubHarnessDb = openDatabase(':memory:');
    const stubHarnessBus = new EventBus();
    const stubHarnessSessions = new SessionService({ db: stubHarnessDb, bus: stubHarnessBus, harnesses: [harness, claudeCliStub], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const stubHarnessApprovals = new ApprovalService({ db: stubHarnessDb, bus: stubHarnessBus });
    const stubHarnessManagerRepo = new ManagerRepository(stubHarnessDb);
    const stubHarnessScheduler = new PulseScheduler({ managers: stubHarnessManagerRepo, sessions: stubHarnessSessions, bus: stubHarnessBus });
    const stubHarnessManagers = new ManagerService({ managers: stubHarnessManagerRepo, sessions: stubHarnessSessions, bus: stubHarnessBus, scheduler: stubHarnessScheduler });
    const stubHarnessServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: stubHarnessSessions, approvals: stubHarnessApprovals, managers: stubHarnessManagers, pulseScheduler: stubHarnessScheduler, bus: stubHarnessBus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
    const stubHarnessApi = (path: string, init: RequestInit = {}) =>
      fetch(`${stubHarnessServer.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
    const session = await (await stubHarnessApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'claude-cli' }) })).json();
    const res = await stubHarnessApi(`/api/sessions/${session.id}/fake-output`, { method: 'POST', body: JSON.stringify({ data: 'x' }) });
    expect(res.status).toBe(404);
    await stubHarnessServer.close();
  });

  it('returns 404 for a missing session', async () => {
    const res = await api('/api/sessions/nope/messages', { method: 'POST', body: JSON.stringify({ body: 'x' }) });
    expect(res.status).toBe(404);
  });

  it('changes a session model and reports relaunching or deferred', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('deferred'); // still 'starting' — the fake session never received SessionStart
  });

  it('resolves a model rung to its full model id when creating a session', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', model: 'sonnet' }) });

    expect((await res.json()).model).toBe(DEFAULT_MODEL_TABLE.sonnet);
  });

  it('resolves a model rung to its full model id when creating a manager', async () => {
    const manager = { pulseSeconds: 900, childrenCap: 2, mission: 'Ship it' };
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'L', harness: 'fake', model: 'fable', manager }) });

    expect((await res.json()).model).toBe(DEFAULT_MODEL_TABLE.fable);
  });

  it('keeps an explicit model id untouched when creating a session', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', model: 'claude-opus-5-5' }) });

    expect((await res.json()).model).toBe('claude-opus-5-5');
  });

  it('404s a model change for an unknown session', async () => {
    const res = await api('/api/sessions/nope/model', { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) });
    expect(res.status).toBe(404);
  });

  it('503s a model change while the daemon is shutting down', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const closing = sessions.closeAll();
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'daemon_shutting_down' });
    await closing;
  });

  it('409s a model change on a session that has already closed', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) });
    expect(res.status).toBe(409);
  });

  it('resolves a rung name to its configured model id before recording it on the session', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) });
    const sessions = await (await api('/api/sessions')).json();
    const updated = sessions.find((s: { id: string }) => s.id === created.id);
    expect(updated.model).toBe(DEFAULT_MODEL_TABLE.sonnet);
  });

  it('resolves a mixed-case rung name to its configured model id before recording it on the session', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'Sonnet' }) });
    const sessions = await (await api('/api/sessions')).json();
    const updated = sessions.find((s: { id: string }) => s.id === created.id);
    expect(updated.model).toBe(DEFAULT_MODEL_TABLE.sonnet);
  });

  it('passes an unrecognized rung name straight through to the session record', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'gpt-4' }) });
    const sessions = await (await api('/api/sessions')).json();
    const updated = sessions.find((s: { id: string }) => s.id === created.id);
    expect(updated.model).toBe('gpt-4');
  });

  it('400s a model change with an empty model string', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: '' }) });
    expect(res.status).toBe(400);
  });

  it('answers a non-JSON model body with a 400 rather than a silent 200', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('renames a session\'s name and emoji via PATCH', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' }) })).json();
    const res = await api(`/api/sessions/${created.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Legolas', emoji: '🏹' }) });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('Legolas');
    expect(updated.emoji).toBe('🏹');
  });

  it('renames only the field given', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' }) })).json();
    const res = await api(`/api/sessions/${created.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Legolas' }) });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('Legolas');
    expect(updated.emoji).toBe('🤖');
  });

  it('allows renaming a closed session — only the label changes', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    const res = await api(`/api/sessions/${created.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Legolas' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('closed');
  });

  it('404s a rename for an unknown session', async () => {
    const res = await api('/api/sessions/nope', { method: 'PATCH', body: JSON.stringify({ name: 'Legolas' }) });
    expect(res.status).toBe(404);
  });

  it('400s a rename with an empty name', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}`, { method: 'PATCH', body: JSON.stringify({ name: '' }) });
    expect(res.status).toBe(400);
  });

  it('400s a rename with neither name nor emoji given', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}`, { method: 'PATCH', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('answers a rename CORS preflight, since the desktop shell will send PATCH cross-origin', async () => {
    const res = await fetch(`${server.url}/api/sessions/whatever`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:1420', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
  });

  it.each(PERMISSION_MODES)('changes the permission mode to "%s" and reports relaunching or deferred', async (mode) => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode }) });
    expect(res.status).toBe(200);
    expect(['relaunching', 'deferred']).toContain((await res.json()).status);
  });

  it('a REST permission-mode change accepts bypassPermissions, unlike the MCP create_session tool', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode: 'bypassPermissions' }) });
    expect(res.status).toBe(200);
  });

  it('404s a permission-mode change for an unknown session', async () => {
    const res = await api('/api/sessions/nope/permission-mode', { method: 'POST', body: JSON.stringify({ mode: 'plan' }) });
    expect(res.status).toBe(404);
  });

  it('400s a permission-mode change with a bogus mode', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode: 'yolo' }) });
    expect(res.status).toBe(400);
  });

  it('503s a permission-mode change while the daemon is shutting down', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const closing = sessions.closeAll();
    const res = await api(`/api/sessions/${created.id}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode: 'plan' }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'daemon_shutting_down' });
    await closing;
  });

  it('409s a permission-mode change on a session that has already closed', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    const res = await api(`/api/sessions/${created.id}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode: 'plan' }) });
    expect(res.status).toBe(409);
  });

  it('reopens a closed session, resuming it with a fresh starting state', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    const res = await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('starting');
  });

  it('lists a reopened session that reached idle without the closedAt and exit code of its earlier close', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
    sessions.applyInput(created.id, { kind: 'hook', event: { session_id: created.id, hook_event_name: 'SessionStart' } as never });

    const listed = (await (await api('/api/sessions')).json()).find((s: { id: string }) => s.id === created.id);

    expect(listed.state).toBe('idle');
    expect(listed.closedAt).toBeUndefined();
    expect(listed.exitCode).toBeUndefined();
  });

  it('404s reopening an unknown session', async () => {
    const res = await api('/api/sessions/nope/reopen', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s reopening a session that is not closed', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('409s reopening a closed session whose directory no longer exists', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp/of-does-not-exist-anywhere', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    const res = await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it.runIf(process.getuid?.() !== 0)('409s reopening a closed session whose directory is unreadable, with a directory_unreadable error body', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'of-rest-unreadable-'));
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: sessionDir, name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });

    chmodSync(sessionDir, 0o000);
    try {
      const res = await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'directory_unreadable' });
    } finally {
      chmodSync(sessionDir, 0o755);
    }
  });

  it('500s reopening a session whose harness fails to relaunch, not a fake 200', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });

    class FailingHarness implements Harness {
      readonly id = 'fake' as const;
      start(_launch: HarnessLaunch): HarnessHandle {
        throw new Error('pty spawn ENOENT');
      }
    }
    // Swaps the running daemon's own harness registration for this session's harness id, so the very next
    // reopen call the running server handles goes through a harness that throws on start.
    (sessions as unknown as { harnessFor: (id: string) => Harness }).harnessFor = () => new FailingHarness();

    const res = await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'launch_failed' });
  });

  it('503s creating a session while the daemon is shutting down', async () => {
    const closing = sessions.closeAll();
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'daemon_shutting_down' });
    await closing;
  });

  it('503s reopening a session while the daemon is shutting down', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });

    const closing = sessions.closeAll();
    const res = await api(`/api/sessions/${created.id}/reopen`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'daemon_shutting_down' });
    await closing;
  });

  it('409s posting a message to a closed session instead of silently queuing it', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });
    const res = await api(`/api/sessions/${created.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hello' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_closed' });
  });

  it('a POST /api/sessions carrying a manager block creates a role=manager session routed through ManagerService, not a plain session', async () => {
    const res = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 60, childrenCap: 2, mission: 'Ship it' } }),
    });
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session.role).toBe('manager');
  });

  it('400s a manager session request with a non-positive pulseSeconds', async () => {
    const res = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 0, childrenCap: 2, mission: 'x' } }),
    });
    expect(res.status).toBe(400);
  });

  it('pulses a manager session on demand and writes the pulse straight to its pty when it is idle', async () => {
    const created = await (await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 3600, childrenCap: 1, mission: 'x' } }),
    })).json();
    const { hookToken } = await (await api(`/api/sessions/${created.id}/tokens`)).json();
    await fetch(`${server.url}/hooks/${hookToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: created.id, hook_event_name: 'SessionStart' }) });

    const res = await api(`/api/managers/${created.id}/pulse`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pulsed: true });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the (0ms) submit-keystroke timer fire
    expect(harness.handles[0]!.written).toEqual(['[pulse] Re-read your mission and continue: check your children, unblock them, record what you did.', '\r']);
  });

  it('answers a manual pulse honestly when one is already queued: pulsed false, coalesced true', async () => {
    const created = await (await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 3600, childrenCap: 1, mission: 'x' } }),
    })).json();
    const { hookToken } = await (await api(`/api/sessions/${created.id}/tokens`)).json();
    const sendHook = (event: object) => fetch(`${server.url}/hooks/${hookToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: created.id, ...event }) });
    await sendHook({ hook_event_name: 'SessionStart' });
    // A Notification/permission_prompt gates delivery the same way a real PermissionRequest would, without
    // going through ApprovalService.request() — a PermissionRequest hook would block this fetch until a
    // human/automated decision resolves it, which never happens in this test.
    await sendHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });

    const first = await api(`/api/managers/${created.id}/pulse`, { method: 'POST' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ pulsed: true });

    const second = await api(`/api/managers/${created.id}/pulse`, { method: 'POST' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ pulsed: false, coalesced: true });
  });

  it('404s a pulse request for a session id with no manager record', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/managers/${created.id}/pulse`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('404s a pulse request for an id that is not a session at all', async () => {
    const res = await api('/api/managers/nope/pulse', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('409s a pulse request for a manager whose session has already closed', async () => {
    const created = await (await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 3600, childrenCap: 1, mission: 'x' } }),
    })).json();
    await api(`/api/sessions/${created.id}/close`, { method: 'POST' });

    const res = await api(`/api/managers/${created.id}/pulse`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_closed' });
  });

  it('rejects a pulse request with no bearer token, same as every other /api/ route', async () => {
    const created = await (await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 60, childrenCap: 1, mission: 'x' } }),
    })).json();
    const res = await fetch(`${server.url}/api/managers/${created.id}/pulse`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('sends a snapshot first, then streams live events', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    const nextMessage = () => new Promise<string>((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true }));

    expect(JSON.parse(await nextMessage())).toEqual({ type: 'snapshot', sessions: [], approvals: [], managers: [] });

    const secondMessage = nextMessage();
    await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) });
    expect(JSON.parse(await secondMessage).type).toBe('session.created');
    ws.close();
  });

  it('snapshot reflects sessions and approvals that already existed before connecting', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    const snapshot = JSON.parse(await new Promise<string>((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true })));
    expect(snapshot.sessions.map((s: { id: string }) => s.id)).toEqual([created.id]);
    ws.close();
  });

  it('answers attach with a replay of recent output, addressed only to the requesting socket', async () => {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    harness.handles[0]!.emitData('hello from pty');

    const requester = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    const bystander = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await Promise.all([requester, bystander].map((ws) => new Promise((r) => ws.addEventListener('message', r, { once: true })))); // wait past each socket's snapshot

    const bystanderSawReplay = new Promise<boolean>((resolve) => {
      bystander.addEventListener('message', (m) => resolve(JSON.parse(String(m.data)).type === 'session.replay'));
    });
    const replay = new Promise<string>((resolve) => requester.addEventListener('message', (m) => resolve(String(m.data)), { once: true }));
    requester.send(JSON.stringify({ type: 'attach', sessionId: session.id }));

    expect(JSON.parse(await replay)).toEqual({ type: 'session.replay', sessionId: session.id, data: 'hello from pty' });
    const raceResult = await Promise.race([bystanderSawReplay, new Promise((r) => setTimeout(() => r('no-message'), 100))]);
    expect(raceResult).not.toBe(true);
    requester.close();
    bystander.close();
  });

  it('ignores a malformed websocket frame instead of crashing the daemon', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.send('not json');
    await new Promise((r) => setTimeout(r, 50));
    const res = await api('/api/sessions');
    expect(res.status).toBe(200);
    ws.close();
  });

  it('ignores a resize message with non-positive dimensions instead of applying it', async () => {
    const session = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((r) => ws.addEventListener('message', r, { once: true })); // wait past the snapshot
    ws.send(JSON.stringify({ type: 'resize', sessionId: session.id, cols: -1, rows: 10 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.handles[0]!.resizes).toEqual([]);
    const res = await api('/api/sessions');
    expect(res.status).toBe(200);
    ws.close();
  });

  it('ignores an attach message with a missing sessionId instead of crashing', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((r) => ws.addEventListener('message', r, { once: true })); // wait past the snapshot
    ws.send(JSON.stringify({ type: 'attach' }));
    await new Promise((r) => setTimeout(r, 50));
    const res = await api('/api/sessions');
    expect(res.status).toBe(200);
    ws.close();
  });
});
