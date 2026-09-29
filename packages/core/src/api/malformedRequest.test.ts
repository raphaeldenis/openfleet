import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
let port: number;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
  port = Number(new URL(server.url).port);
});
afterEach(() => server.close());

// A raw socket, not fetch(): fetch() refuses to send a request whose target isn't a valid URL, so the only
// way to reproduce what a browser's HTTP/1.1 layer forwards verbatim is to write the request line by hand.
function sendRawRequest(request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
    const finish = () => resolve(received.split('\r\n')[0] ?? '');
    socket.on('close', finish);
    socket.on('error', finish);
    setTimeout(finish, 1500);
  });
}

describe('a request whose URL does not parse', () => {
  it('answers 400 instead of crashing the daemon', async () => {
    const statusLine = await sendRawRequest('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    expect(statusLine).toContain(' 400 ');
  });

  it('leaves the daemon serving the next request', async () => {
    await sendRawRequest('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
  });

  it('refuses an unparsable WS upgrade target without crashing the daemon', async () => {
    const statusLine = await sendRawRequest(
      'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    expect(statusLine).not.toContain('101');
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
  });
});
