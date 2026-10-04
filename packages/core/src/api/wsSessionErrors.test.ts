import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as ServerSideWebSocket } from 'ws';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import type { HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

type Frame = Record<string, unknown>;

class LaunchFailingHarness extends FakeHarness {
  override start(_launch: HarnessLaunch): HarnessHandle {
    throw new Error('spawn ENOENT /Users/someone/secret-dir/claude');
  }
}

const openSockets: WebSocket[] = [];
let runningServer: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of openSockets.splice(0)) socket.close();
  await runningServer?.close();
  runningServer = undefined;
});

async function boot(options: { harness?: FakeHarness; firstStartTimeoutMs?: number; submitKeystrokeDelayMs?: number } = {}) {
  const harness = options.harness ?? new FakeHarness();
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt',
    firstStartTimeoutMs: options.firstStartTimeoutMs, submitKeystrokeDelayMs: options.submitKeystrokeDelayMs, describeError });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus });
  runningServer = server;
  return { server, sessions, harness };
}

async function openClient(server: { url: string }): Promise<Frame[]> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Frame[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitForFrame(frames, (frame) => frame.type === 'snapshot');
  return frames;
}

async function waitForFrame(frames: Frame[], matches: (frame: Frame) => boolean): Promise<Frame> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 800)}`);
}

const isType = (type: string) => (frame: Frame) => frame.type === type;
const isErrorEvent = isType('error');
const spec = { name: 'a', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

describe('session-scoped error broadcasts', () => {
  it('launch failed: closes the row with exit -2, reason launch_failed, and broadcasts the launch_failed envelope without the spawn detail', async () => {
    const { server, sessions } = await boot({ harness: new LaunchFailingHarness() });
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sessions.create(spec)).rejects.toThrow();
    const closed = await waitForFrame(frames, isType('session.closed'));
    const errorEvent = await waitForFrame(frames, isErrorEvent);

    expect(closed).toMatchObject({ reason: 'launch_failed' });
    expect(closed.exitCode).toBeUndefined();
    expect(errorEvent).toMatchObject({ sessionId: closed.sessionId, error: { error: 'launch_failed', kind: 'internal', id: expect.stringMatching(/^[0-9a-f]{8}$/) } });
    expect(JSON.stringify(errorEvent)).not.toContain('secret-dir');
  });

  it('launch failed: the only error log record carries the id of the envelope and the original spawn cause', async () => {
    const { server, sessions } = await boot({ harness: new LaunchFailingHarness() });
    const frames = await openClient(server);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sessions.create(spec)).rejects.toThrow();
    const errorEvent = await waitForFrame(frames, isErrorEvent);
    const id = (errorEvent.error as { id: string }).id;

    expect(logged.mock.calls).toHaveLength(1);
    const [onlyRecord] = logged.mock.calls[0]!.map(String);
    expect(onlyRecord).toContain(id);
    expect(onlyRecord).toContain('spawn ENOENT');
  });

  it('resume timeout: closes the row with exit -1, reason resume_timeout, and broadcasts the resume_timeout envelope', async () => {
    const { server, sessions } = await boot({ firstStartTimeoutMs: 30 });
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const session = await sessions.create(spec);
    const closed = await waitForFrame(frames, isType('session.closed'));
    const errorEvent = await waitForFrame(frames, isErrorEvent);

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, reason: 'resume_timeout' });
    expect(errorEvent).toMatchObject({ sessionId: session.id, error: { error: 'resume_timeout', kind: 'internal' } });
  });

  it('harness exit: a non-zero exit nobody asked for closes with reason harness_exit and broadcasts harness_exited', async () => {
    const { server, sessions, harness } = await boot();
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await sessions.create(spec);

    harness.handles[0]!.emitExit(1);
    const closed = await waitForFrame(frames, isType('session.closed'));
    const errorEvent = await waitForFrame(frames, isErrorEvent);

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, exitCode: 1, reason: 'harness_exit' });
    expect(errorEvent).toMatchObject({ sessionId: session.id, error: { error: 'harness_exited', kind: 'unavailable', retry: 'never' } });
  });

  it('closed by user: the kill exit code (137) closes with reason closed_by_user and broadcasts no error', async () => {
    const { server, sessions } = await boot();
    const frames = await openClient(server);
    const session = await sessions.create(spec);

    await sessions.close(session.id);
    const closed = await waitForFrame(frames, isType('session.closed'));

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, exitCode: 137, reason: 'closed_by_user' });
    expect(frames.filter(isErrorEvent)).toEqual([]);
  });

  it('a clean exit 0 nobody asked for carries no reason and broadcasts no error', async () => {
    const { server, sessions, harness } = await boot();
    const frames = await openClient(server);
    const session = await sessions.create(spec);

    harness.handles[0]!.emitExit(0);
    const closed = await waitForFrame(frames, isType('session.closed'));

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, exitCode: 0 });
    expect(frames.filter(isErrorEvent)).toEqual([]);
  });

  it('delivery failure streak: broadcasts delivery_failed once per streak, not once per retry', async () => {
    const { server, sessions, harness } = await boot({ submitKeystrokeDelayMs: 10 });
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await sessions.create(spec);
    sessions.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionStart' } as never });
    const handle: FakeHandle = harness.handles[0]!;
    handle.write = () => { throw new Error('pty write failed'); };

    sessions.sendMessage({ sessionId: session.id, body: 'do X' });
    const errorEvent = await waitForFrame(frames, isErrorEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(errorEvent).toMatchObject({ sessionId: session.id, error: { error: 'delivery_failed', kind: 'unavailable', retry: 'later' } });
    expect(frames.filter(isErrorEvent)).toHaveLength(1);
  });
});

describe('a broadcast never breaks the session pipeline', () => {
  it('a client whose send throws does not stop the other clients or the close flow', async () => {
    const { server, sessions } = await boot();
    const brokenFrames = await openClient(server);
    const healthyFrames = await openClient(server);
    const session = await sessions.create(spec);
    const originalSend = ServerSideWebSocket.prototype.send;
    // The first server-side socket to send after this point is the first client's (wss.clients keeps connection order).
    const serverSideSockets: unknown[] = [];
    vi.spyOn(ServerSideWebSocket.prototype, 'send').mockImplementation(function (this: ServerSideWebSocket, ...args: Parameters<typeof originalSend>) {
      if (!serverSideSockets.includes(this)) serverSideSockets.push(this);
      if (serverSideSockets[0] === this) throw new Error('EPIPE');
      return originalSend.apply(this, args);
    } as typeof originalSend);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sessions.close(session.id)).resolves.toBeUndefined();

    await waitForFrame(healthyFrames, isType('session.closed'));
    expect(brokenFrames.filter(isType('session.closed'))).toEqual([]);
    expect(sessions.get(session.id)?.state).toBe('closed');
  });
});
