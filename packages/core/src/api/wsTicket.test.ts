import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
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
import { createWsTicketStore } from './wsTicketStore.js';

let server: Awaited<ReturnType<typeof startServer>>;
let clockMs: number;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  clockMs = 0;
  const wsTickets = createWsTicketStore({ ttlMs: 30_000, now: () => clockMs });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', wsTickets });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });

async function issueTicket(): Promise<string> {
  const res = await api('/api/ws-ticket', { method: 'POST' });
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

function tryConnectWithQuery(query: string): Promise<'accepted' | 'refused'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws${query}`);
    const timer = setTimeout(() => { socket.terminate(); resolve('refused'); }, 2000);
    socket.on('open', () => { clearTimeout(timer); socket.close(); resolve('accepted'); });
    socket.on('error', () => { clearTimeout(timer); resolve('refused'); });
    socket.on('unexpected-response', () => { clearTimeout(timer); resolve('refused'); });
  });
}

describe('POST /api/ws-ticket', () => {
  it('401s without a bearer token, same as every other /api/ route', async () => {
    const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('issues a ticket to a bearer-authenticated caller', async () => {
    const res = await api('/api/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string };
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(0);
  });
});

describe('WS ticket', () => {
  it('accepts a connection carrying a freshly issued ticket', async () => {
    const ticket = await issueTicket();
    expect(await tryConnectWithQuery(`?ticket=${ticket}`)).toBe('accepted');
  });

  it('refuses a second connection that reuses an already-consumed ticket', async () => {
    const ticket = await issueTicket();
    expect(await tryConnectWithQuery(`?ticket=${ticket}`)).toBe('accepted');

    expect(await tryConnectWithQuery(`?ticket=${ticket}`)).toBe('refused');
  });

  it('refuses a ticket that has expired', async () => {
    const ticket = await issueTicket();
    clockMs += 30_001;

    expect(await tryConnectWithQuery(`?ticket=${ticket}`)).toBe('refused');
  });

  it('refuses a connection with no ticket at all', async () => {
    expect(await tryConnectWithQuery('')).toBe('refused');
  });

  it('no longer accepts the old ?token= admin credential', async () => {
    expect(await tryConnectWithQuery('?token=admin')).toBe('refused');
  });
});
