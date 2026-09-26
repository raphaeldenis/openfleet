import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
let harness: FakeHarness;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE });
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
      start: () => ({ write: () => {}, resize: () => {}, kill: () => {}, onData: () => () => {}, onExit: () => () => {} }),
    };
    const stubHarnessDb = openDatabase(':memory:');
    const stubHarnessBus = new EventBus();
    const stubHarnessSessions = new SessionService({ db: stubHarnessDb, bus: stubHarnessBus, harnesses: [harness, claudeCliStub], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const stubHarnessApprovals = new ApprovalService({ db: stubHarnessDb, bus: stubHarnessBus });
    const stubHarnessManagerRepo = new ManagerRepository(stubHarnessDb);
    const stubHarnessScheduler = new PulseScheduler({ managers: stubHarnessManagerRepo, sessions: stubHarnessSessions, bus: stubHarnessBus });
    const stubHarnessManagers = new ManagerService({ managers: stubHarnessManagerRepo, sessions: stubHarnessSessions, bus: stubHarnessBus, scheduler: stubHarnessScheduler });
    const stubHarnessServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: stubHarnessSessions, approvals: stubHarnessApprovals, managers: stubHarnessManagers, pulseScheduler: stubHarnessScheduler, bus: stubHarnessBus, modelTable: DEFAULT_MODEL_TABLE });
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

  it('changes a session model and reports delivered or queued', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('queued'); // still 'starting' — the fake session never received SessionStart
  });

  it('404s a model change for an unknown session', async () => {
    const res = await api('/api/sessions/nope/model', { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) });
    expect(res.status).toBe(404);
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

  it('answers a non-JSON model body with a server error rather than a silent 200', async () => {
    const created = await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) })).json();
    const res = await api(`/api/sessions/${created.id}/model`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(500);
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
