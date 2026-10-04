import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import type { HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

type Frame = Record<string, unknown>;

class FlakyLaunchHarness extends FakeHarness {
  failsToLaunch = true;
  override start(launch: HarnessLaunch): HarnessHandle {
    if (this.failsToLaunch) throw new Error('spawn ENOENT');
    return super.start(launch);
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

// Two services share one database and one bus: `sessions` is the previous run that created the rows,
// `restartedSessions` is the daemon after a restart (it owns no process handle) and is the one the server uses.
async function boot(options: { harness?: FakeHarness; restartedHarnesses?: FakeHarness[] } = {}) {
  const harness = options.harness ?? new FakeHarness();
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const newService = (harnesses: FakeHarness[]) => new SessionService({ db, bus, harnesses, baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 10, describeError });
  const sessions = newService([harness]);
  const restartedSessions = newService(options.restartedHarnesses ?? [harness]);
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions: restartedSessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions: restartedSessions, bus, scheduler: pulseScheduler });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: restartedSessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus });
  runningServer = server;
  return { server, sessions, restartedSessions, harness };
}

async function openClient(server: { url: string }): Promise<{ socket: WebSocket; frames: Frame[] }> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Frame[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitFor(() => frames.find(isType('snapshot')));
  return { socket, frames };
}

async function waitFor<T>(find: () => T | undefined, attempts = 500): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never met');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const isType = (type: string) => (frame: Frame) => frame.type === type;
const isError = isType('error');
const isClosed = isType('session.closed');
const spec = { name: 'a', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

describe('a client that connects after a session closed', () => {
  it('receives the close reason in its snapshot, the same one the live clients were told', async () => {
    const { server, sessions, restartedSessions } = await boot();
    const session = await sessions.create(spec);
    const liveClient = await openClient(server);
    await restartedSessions.close(session.id);
    const liveClosure = await waitFor(() => liveClient.frames.find(isClosed));

    const lateClient = await openClient(server);

    const snapshot = lateClient.frames.find(isType('snapshot')) as { sessions: { id: string; state: string; closeReason?: string }[] };
    expect(snapshot.sessions.find((candidate) => candidate.id === session.id)).toMatchObject({ state: 'closed', closeReason: liveClosure.reason });
    expect(liveClosure.reason).toBe('closed_by_user');
  });

  it('reads the close reason from the REST session list', async () => {
    const { server, sessions, restartedSessions } = await boot();
    const session = await sessions.create(spec);
    await restartedSessions.close(session.id);

    const response = await fetch(`${server.url}/api/sessions`, { headers: { authorization: 'Bearer admin' } });
    const listed = (await response.json()) as { id: string; closeReason?: string }[];

    expect(listed.find((candidate) => candidate.id === session.id)?.closeReason).toBe('closed_by_user');
  });

  it('receives no close reason for the session once it is reopened', async () => {
    const { server, sessions, restartedSessions } = await boot();
    const session = await sessions.create(spec);
    await restartedSessions.close(session.id);
    restartedSessions.reopen(session.id);

    const lateClient = await openClient(server);

    const snapshot = lateClient.frames.find(isType('snapshot')) as { sessions: { id: string; closeReason?: string }[] };
    expect(snapshot.sessions.find((candidate) => candidate.id === session.id)?.closeReason).toBeUndefined();
  });
});

describe('a session closed after a daemon restart', () => {
  it('a row whose harness is no longer registered closes with undefined exitCode, reason launch_failed and the launch_failed envelope', async () => {
    const { server, sessions, restartedSessions } = await boot({ restartedHarnesses: [] });
    const session = await sessions.create(spec);
    const { frames } = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    void restartedSessions.resumeAll();
    const closed = await waitFor(() => frames.find(isClosed));
    const errorEvent = await waitFor(() => frames.find(isError));

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, reason: 'launch_failed' });
    expect(errorEvent).toMatchObject({ sessionId: session.id, error: { error: 'launch_failed', kind: 'internal' } });
  });

  it('a row whose harness refuses to start closes with undefined exitCode, reason launch_failed and the launch_failed envelope', async () => {
    const { server, sessions, restartedSessions } = await boot({ restartedHarnesses: [new FlakyLaunchHarness()] });
    const session = await sessions.create(spec);
    const { frames } = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    void restartedSessions.resumeAll();
    const closed = await waitFor(() => frames.find(isClosed));
    const errorEvent = await waitFor(() => frames.find(isError));

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, reason: 'launch_failed' });
    expect(errorEvent).toMatchObject({ sessionId: session.id, error: { error: 'launch_failed' } });
  });

  it('closing a row this daemon owns no process for closes it with reason closed_by_user and no error event', async () => {
    const { server, sessions, restartedSessions } = await boot();
    const session = await sessions.create(spec);
    const { frames } = await openClient(server);

    await restartedSessions.close(session.id);
    const closed = await waitFor(() => frames.find(isClosed));
    await settle();

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, reason: 'closed_by_user' });
    expect(frames.filter(isError)).toEqual([]);
  });

  it('a client connecting after the failure sees the closed row in its snapshot, and no error event is replayed', async () => {
    const { server, sessions, restartedSessions } = await boot({ restartedHarnesses: [] });
    const session = await sessions.create(spec);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    void restartedSessions.resumeAll();
    await waitFor(() => restartedSessions.get(session.id)?.state === 'closed' || undefined);

    const { frames } = await openClient(server);
    await settle();

    const snapshot = frames.find(isType('snapshot')) as { sessions: { id: string; state: string; exitCode?: number }[] };
    const snapshotSession = snapshot.sessions.find((s) => s.id === session.id)!;
    expect(snapshotSession).toMatchObject({ state: 'closed' });
    expect(snapshotSession.exitCode).toBeUndefined();
    expect(frames.filter(isError)).toEqual([]);
    expect(frames.filter(isClosed)).toEqual([]);
  });
});

describe('the exit codes that predate the reason', () => {
  it('a session that never reports a hook closes with undefined exitCode and reason resume_timeout', async () => {
    const harness = new FakeHarness();
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', firstStartTimeoutMs: 30, describeError });
    const approvals = new ApprovalService({ db, bus });
    const managerRepo = new ManagerRepository(db);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
    const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
    runningServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus });
    const { frames } = await openClient(runningServer);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const session = await sessions.create(spec);
    const closed = await waitFor(() => frames.find(isClosed));

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, reason: 'resume_timeout' });
  });
});

describe('a delivery that keeps failing', () => {
  it('announces delivery_failed once even when a turn boundary makes the daemon retry and fail again', async () => {
    const { server, sessions, harness } = await boot();
    const { frames } = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await sessions.create(spec);
    const hook = (hook_event_name: string) => sessions.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name } as never });
    hook('SessionStart');
    harness.handles[0]!.write = () => { throw new Error('pty write failed'); };
    harness.handles[0]!.typeMessage = () => { throw new Error('pty write failed'); };

    sessions.sendMessage({ sessionId: session.id, body: 'do X' });
    await waitFor(() => frames.find(isError));
    hook('UserPromptSubmit');
    hook('Stop');
    await settle();
    hook('UserPromptSubmit');
    hook('Stop');
    await settle();

    expect(frames.filter(isError).map((frame) => (frame.error as { error: string }).error)).toEqual(['delivery_failed']);
  });
});

describe('a session reopened after a launch failure', () => {
  it('closes for the user later with reason closed_by_user, not with the earlier launch_failed', async () => {
    const harness = new FlakyLaunchHarness();
    const { server, restartedSessions } = await boot({ harness });
    const { frames } = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await restartedSessions.create(spec).catch(() => undefined);
    const firstClosed = await waitFor(() => frames.find(isClosed));
    const sessionId = firstClosed.sessionId as string;
    harness.failsToLaunch = false;

    restartedSessions.reopen(sessionId);
    await restartedSessions.close(sessionId);
    const closings = await waitFor(() => (frames.filter(isClosed).length >= 2 ? frames.filter(isClosed) : undefined));

    expect(closings[0]!).toMatchObject({ reason: 'launch_failed' });
    expect(closings[0]!.exitCode).toBeUndefined();
    expect(closings[1]!).toMatchObject({ reason: 'closed_by_user' });
    expect(frames.filter(isError)).toHaveLength(1);
  });
});

describe('several sessions ending at once', () => {
  it('two harnesses exiting non-zero together each announce harness_exited under their own session id', async () => {
    const { server, sessions, harness } = await boot();
    const first = await sessions.create(spec);
    const second = await sessions.create(spec);
    const { frames } = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    harness.handles[0]!.emitExit(1);
    harness.handles[1]!.emitExit(2);
    await waitFor(() => (frames.filter(isError).length >= 2 ? true : undefined));
    await settle();

    const announced = frames.filter(isError).map((frame) => frame.sessionId).sort();
    expect(announced).toEqual([first.id, second.id].sort());
    const reasonsBySession = Object.fromEntries(frames.filter(isClosed).map((frame) => [frame.sessionId, [frame.exitCode, frame.reason]]));
    expect(reasonsBySession).toEqual({ [first.id]: [1, 'harness_exit'], [second.id]: [2, 'harness_exit'] });
  });

  it('a daemon shutdown closing every session announces no error and gives every session the daemon_shutdown reason', async () => {
    const { server, sessions } = await boot();
    await sessions.create(spec);
    await sessions.create(spec);
    const { frames } = await openClient(server);

    await sessions.closeAll();
    await waitFor(() => (frames.filter(isClosed).length >= 2 ? true : undefined));
    await settle();

    expect(frames.filter(isError)).toEqual([]);
    expect(frames.filter(isClosed).map((frame) => frame.reason)).toEqual(['daemon_shutdown', 'daemon_shutdown']);
  });
});

describe('what an error event may carry', () => {
  it('a harness_exited event carries neither the session directory nor any token, and its session is on exactly one error log line', async () => {
    const secretDirectory = mkdtempSync(join(tmpdir(), 'of-secret-dir-'));
    const { server, sessions, harness } = await boot();
    await sessions.create({ ...spec, directory: secretDirectory });
    const { frames } = await openClient(server);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch = harness.launches[0]!;

    harness.handles[0]!.emitExit(1);
    const errorEvent = await waitFor(() => frames.find(isError));
    const wire = JSON.stringify(errorEvent);
    const sessionId = launch.sessionId;

    expect(wire).not.toContain(secretDirectory);
    expect(wire).not.toContain(launch.mcpToken);
    expect(wire).not.toContain(launch.hookUrl);
    expect(wire.length).toBeLessThan(2048);
    expect(logged.mock.calls.filter((call) => call.some((part) => String(part).includes(sessionId)))).toHaveLength(1);
  });
});

describe('a flood of failing client frames', () => {
  it('1000 input frames for a closed session get one small error event each, and no error log line', async () => {
    const { server, sessions, restartedSessions } = await boot();
    const session = await sessions.create(spec);
    await restartedSessions.close(session.id);
    const { socket, frames } = await openClient(server);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oneKilobyte = 'x'.repeat(1024);

    for (let frame = 0; frame < 1000; frame += 1) socket.send(JSON.stringify({ type: 'input', sessionId: session.id, data: oneKilobyte }));
    await waitFor(() => (frames.filter(isError).length >= 1000 ? true : undefined), 1500);
    await settle();

    const errors = frames.filter(isError);
    expect(errors).toHaveLength(1000);
    expect(new Set(errors.map((event) => JSON.stringify(event))).size).toBeLessThanOrEqual(1000);
    expect(Math.max(...errors.map((event) => JSON.stringify(event).length))).toBeLessThan(2048);
    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });
});
