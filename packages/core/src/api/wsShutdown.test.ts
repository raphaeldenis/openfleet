import { describe, expect, it, vi } from 'vitest';
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

// Mirrors the audit's own probe-shutdown.ts: server.close() used to wait forever on an upgraded WS
// socket that closeAllConnections() never covers (MAJ-08/AUD-08).
describe('server shutdown with a connected WS client', () => {
  it('server.close() settles within a bound and the client sees its socket close (AUD-08)', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const approvals = new ApprovalService({ db, bus });
    const managerRepo = new ManagerRepository(db);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
    const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
    const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });

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
});
