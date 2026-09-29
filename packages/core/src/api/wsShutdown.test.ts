import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { openDatabase } from '../db/database.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

async function startProbeServer(overrides: Partial<Parameters<typeof startServer>[0]> = {}) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  return startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', ...overrides });
}

// Performs the WS handshake at the raw HTTP level and then never speaks the protocol again: no close-frame
// ack, no writes at all. Only terminate() can ever end a connection like this one.
function openNonCooperativeSocket(serverUrl: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: '/ws?token=admin',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (_res, socket) => { socket.on('data', () => {}); resolve(socket); });
    req.on('error', reject);
    req.end();
  });
}

// Mirrors the audit's own probe-shutdown.ts: server.close() used to wait forever on an upgraded WS
// socket that closeAllConnections() never covers (MAJ-08/AUD-08).
describe('server shutdown with a connected WS client', () => {
  it('server.close() settles within a bound and the client sees its socket close (AUD-08)', async () => {
    const server = await startProbeServer();

    const client = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((resolve) => client.addEventListener('message', resolve, { once: true })); // the initial snapshot
    let clientClosed = false;
    client.addEventListener('close', () => { clientClosed = true; });

    const outcome = await Promise.race([
      server.close().then(() => 'settled' as const),
      new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 2000)),
    ]);

    expect(outcome).toBe('settled');
    // The client's own 'close' event is delivered over the real loopback socket, a tick or two behind
    // server.close()'s own callback — wait for it rather than asserting the instant server.close() settles.
    await vi.waitFor(() => expect(clientClosed).toBe(true));
  });

  it('sends a going-away close frame (1001, daemon shutting down) instead of an unexplained drop (AUD-08)', async () => {
    const server = await startProbeServer();
    const client = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`);
    await new Promise((resolve) => client.on('message', resolve)); // the initial snapshot
    const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
      client.on('close', (code: number, reasonBuf: Buffer) => resolve({ code, reason: reasonBuf.toString() }));
    });

    await server.close();

    expect(await closeInfo).toEqual({ code: 1001, reason: 'daemon shutting down' });
  });

  it('still completes shutdown promptly against a non-cooperative client that never answers the close handshake (AUD-08)', async () => {
    // A tiny grace so the test stays fast; production defaults to a longer one.
    const server = await startProbeServer({ wsCloseGraceMs: 20 });
    const deadSocket = await openNonCooperativeSocket(server.url);
    let deadSocketClosed = false;
    deadSocket.on('close', () => { deadSocketClosed = true; });

    const outcome = await Promise.race([
      server.close().then(() => 'settled' as const),
      new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 2000)),
    ]);

    expect(outcome).toBe('settled');
    // Same reasoning as the cooperative-client test above: the raw socket's own 'close' event lands a tick
    // or two behind server.close()'s callback.
    await vi.waitFor(() => expect(deadSocketClosed).toBe(true));
  });
});
