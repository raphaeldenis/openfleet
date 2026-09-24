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
  it('rejects a missing bearer token', async () => {
    const res = await fetch(`${server.url}/api/sessions`);
    expect(res.status).toBe(401);
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
});
