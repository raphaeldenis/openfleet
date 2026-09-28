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

let server: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
});
afterEach(() => server.close());

// The 'ws' package's client, not the native global WebSocket: only it lets a test set a custom Origin
// header, which a real browser's WebSocket constructor never allows a page to override.
function tryConnect(headers: Record<string, string> = {}): Promise<'accepted' | 'refused'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=admin`, { headers });
    const timer = setTimeout(() => { socket.terminate(); resolve('refused'); }, 2000);
    socket.on('open', () => { clearTimeout(timer); socket.close(); resolve('accepted'); });
    socket.on('error', () => { clearTimeout(timer); resolve('refused'); });
    socket.on('unexpected-response', () => { clearTimeout(timer); resolve('refused'); });
  });
}

describe('WS Origin allowlist', () => {
  it('accepts a connection with no Origin header, for non-browser clients', async () => {
    expect(await tryConnect()).toBe('accepted');
  });

  it('accepts a connection from the desktop shell\'s dev front origin', async () => {
    expect(await tryConnect({ Origin: 'http://localhost:1420' })).toBe('accepted');
  });

  it('refuses a connection from a foreign Origin even with a valid token', async () => {
    expect(await tryConnect({ Origin: 'https://evil.example' })).toBe('refused');
  });
});
