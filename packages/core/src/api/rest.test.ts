import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, bus });
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

  it('echoes the request origin on real responses so the browser accepts the fetch', async () => {
    const res = await fetch(`${server.url}/api/sessions`, { headers: { authorization: 'Bearer admin', origin: 'http://localhost:1420' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
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
    const stubHarnessServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: stubHarnessSessions, approvals: stubHarnessApprovals, bus: stubHarnessBus });
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

  it('streams events over websocket', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    const first = new Promise<string>((resolve) => ws.addEventListener('message', (m) => resolve(String(m.data)), { once: true }));
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'G', harness: 'fake' }) });
    expect(JSON.parse(await first).type).toBe('session.created');
    ws.close();
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
});
