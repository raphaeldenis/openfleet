import type { DaemonIssue } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsSocket } from 'ws';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { createDegradedRegistry, type DegradedRegistry } from '../process/degradedRegistry.js';
import { SessionService } from '../sessions/sessionService.js';
import { DAEMON_VERSION } from '../version.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let degraded: DegradedRegistry;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  degraded = createDegradedRegistry();
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus, degraded });
});
afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await server.close();
  vi.restoreAllMocks();
});

const health = () => fetch(`${server.url}/health`);

async function openClient(): Promise<{ frames: Record<string, unknown>[] }> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitForFrame(frames, (frame) => frame.type === 'snapshot');
  return { frames };
}

async function waitForFrame(frames: Record<string, unknown>[], matches: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 500)}`);
}

describe('GET /health and the degraded state', () => {
  it('answers 200 ok with status ok and no issue while nothing is wrong', async () => {
    const res = await health();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: DAEMON_VERSION, status: 'ok', issues: 0 });
  });

  it('keeps answering 200 with ok true while degraded: the app probe treats any other answer as a daemon that does not answer', async () => {
    degraded.mark('db_stuck', 'the database is not accepting writes.');
    degraded.mark('hook_fail_open', 'hooks fail open.');

    const res = await health();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: DAEMON_VERSION, status: 'degraded', issues: 2 });
  });

  it('goes back to status ok once the issues clear', async () => {
    degraded.mark('db_stuck', 'the database is not accepting writes.');
    degraded.clear('db_stuck');

    expect(await (await health()).json()).toMatchObject({ ok: true, status: 'ok', issues: 0 });
  });

  it('does not list the issues to an unauthenticated caller', async () => {
    degraded.mark('db_stuck', 'the database is not accepting writes.');

    const body = JSON.stringify(await (await health()).json());

    expect(body).not.toContain('not accepting writes');
  });

  it('answers 503 shutting_down during the shutdown even when degraded, as before', async () => {
    degraded.mark('db_stuck', 'the database is not accepting writes.');
    server.beginShutdown();

    const res = await health();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, status: 'shutting_down' });
  });

  it('hostile 6: answers /health while the server is closing, or refuses the connection, and never hangs', async () => {
    server.beginShutdown();
    const closing = server.close();

    const outcome = await Promise.race([
      health().then((res) => res.status, () => 'refused'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);
    await closing;

    expect([503, 'refused']).toContain(outcome);
  });
});

describe('the degraded state over the WebSocket', () => {
  it('puts the current issues in the snapshot', async () => {
    degraded.mark('db_stuck', 'the database is not accepting writes.');

    const { frames } = await openClient();

    const snapshot = frames.find((frame) => frame.type === 'snapshot') as { daemonIssues: DaemonIssue[] };
    expect(snapshot.daemonIssues).toMatchObject([{ code: 'db_stuck', count: 1 }]);
  });

  it('puts an empty list in the snapshot of a healthy daemon', async () => {
    const { frames } = await openClient();

    expect(frames.find((frame) => frame.type === 'snapshot')).toMatchObject({ daemonIssues: [] });
  });

  it('marks ws_broadcast_failed when a client send throws, and clears it on the next broadcast every client receives', async () => {
    const { frames } = await openClient();
    const failingSend = vi.spyOn(WsSocket.prototype, 'send').mockImplementation(() => { throw new Error('socket exploded'); });

    degraded.mark('db_stuck', 'the database is not accepting writes.');
    expect(degraded.list().map((issue) => issue.code)).toEqual(['db_stuck', 'ws_broadcast_failed']);
    failingSend.mockRestore();
    degraded.mark('hook_fail_open', 'hooks fail open.');

    await waitForFrame(frames, (frame) => frame.type === 'daemon.issues' && (frame.issues as { code: string }[]).some((issue) => issue.code === 'hook_fail_open'));
    expect(degraded.list().map((issue) => issue.code)).toEqual(['db_stuck', 'hook_fail_open']);
  });

  it('marks ws_broadcast_failed when the send callback reports a write error: the real failure mode of an open socket', async () => {
    await openClient();
    const failingWrite = vi.spyOn(WsSocket.prototype, 'send').mockImplementation(((_data: unknown, callback?: (error?: Error) => void) => { callback?.(new Error('write EPIPE')); }) as never);

    degraded.mark('db_stuck', 'the database is not accepting writes.');
    failingWrite.mockRestore();

    expect(degraded.list().map((issue) => issue.code)).toContain('ws_broadcast_failed');
  });

  it('clears ws_broadcast_failed once a later broadcast is written to every client without error', async () => {
    const { frames } = await openClient();
    const failingWrite = vi.spyOn(WsSocket.prototype, 'send').mockImplementation(((_data: unknown, callback?: (error?: Error) => void) => { callback?.(new Error('write EPIPE')); }) as never);
    degraded.mark('db_stuck', 'the database is not accepting writes.');
    failingWrite.mockRestore();

    degraded.mark('hook_fail_open', 'hooks fail open.');

    await vi.waitFor(() => expect(degraded.list().map((issue) => issue.code)).not.toContain('ws_broadcast_failed'));
    expect(frames.some((frame) => frame.type === 'daemon.issues')).toBe(true);
  });

  it('broadcasts daemon.issues with the full list when an issue appears and when it clears, and on nothing else', async () => {
    const { frames } = await openClient();

    degraded.mark('db_stuck', 'the database is not accepting writes.');
    degraded.mark('db_stuck', 'the database is not accepting writes.');
    degraded.clear('db_stuck');
    degraded.clear('db_stuck');
    await waitForFrame(frames, (frame) => frame.type === 'daemon.issues' && (frame.issues as unknown[]).length === 0);

    const issueFrames = frames.filter((frame) => frame.type === 'daemon.issues') as { issues: DaemonIssue[] }[];
    expect(issueFrames.map(({ issues }) => issues.map((issue) => issue.code))).toEqual([['db_stuck'], []]);
  });
});
