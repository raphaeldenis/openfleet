import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { EARLY_EXIT_WINDOW_MS, SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

type Frame = Record<string, unknown>;

const SESSION_END_GRACE_MS = 60;
const SIGKILL_EXIT_CODE = 137;
const SIGTERM_EXIT_CODE = 143;
const SIGHUP_EXIT_CODE = 129;

const openSockets: WebSocket[] = [];
let runningServer: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of openSockets.splice(0)) socket.close();
  await runningServer?.close();
  runningServer = undefined;
});

async function boot() {
  const harness = new FakeHarness();
  const clock = { nowMs: 1_000_000 };
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt',
    sessionEndExitGraceMs: SESSION_END_GRACE_MS, clearFlushGraceMs: 10, now: () => clock.nowMs, describeError });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus });
  runningServer = server;
  return { server, sessions, harness, clock };
}

async function openClient(server: { url: string }): Promise<Frame[]> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Frame[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitFor(() => frames.find(isType('snapshot')));
  return frames;
}

async function waitFor<T>(find: () => T | undefined, attempts = 300): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never met');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SESSION_END_GRACE_MS * 3));
const isType = (type: string) => (frame: Frame) => frame.type === type;
const isError = isType('error');
const isClosed = isType('session.closed');
const spec = { name: 'a', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;
const errorOf = (frame: Frame) => frame.error as { error: string; kind: string; retry: string; message: string; hint?: string; id?: string };

const endSession = (sessions: SessionService, sessionId: string, extra: object = {}) =>
  sessions.applyInput(sessionId, { kind: 'hook', event: { session_id: sessionId, hook_event_name: 'SessionEnd', ...extra } as never });

describe('a process that dies by a signal', () => {
  it.each([
    { label: 'SIGKILL', exitCode: SIGKILL_EXIT_CODE, signal: 9 },
    { label: 'SIGTERM', exitCode: SIGTERM_EXIT_CODE, signal: 15 },
  ])('closes with reason harness_exit and announces the signal after a $label nobody asked for', async ({ exitCode, signal }) => {
    const { server, sessions, harness, clock } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.nowMs += EARLY_EXIT_WINDOW_MS + 1;

    harness.handles[0]!.emitExit(exitCode);
    const closed = await waitFor(() => frames.find(isClosed));
    const errorEvent = await waitFor(() => frames.find(isError));

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, exitCode, reason: 'harness_exit' });
    expect(errorOf(errorEvent)).toMatchObject({ error: 'harness_exited', kind: 'unavailable', retry: 'never', message: `the agent process was killed (signal ${signal}).` });
  });
});

describe('a CLI that ends its own session (SessionEnd)', () => {
  it('answers the hook at once, and closes with closed_by_user and no error when the CLI then exits 0 on its own', async () => {
    const { server, sessions, harness } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);

    endSession(sessions, session.id);
    expect(harness.handles[0]!.killed).toBe(false);
    harness.handles[0]!.emitExit(0);
    const closed = await waitFor(() => frames.find(isClosed));
    await settle();

    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, exitCode: 0, reason: 'closed_by_user' });
    expect(frames.filter(isError)).toEqual([]);
    expect(harness.handles[0]!.killed).toBe(false);
  });

  it.each([
    { label: 'a SIGTERM (143)', exitCode: SIGTERM_EXIT_CODE },
    { label: 'a SIGHUP (129)', exitCode: SIGHUP_EXIT_CODE },
    { label: 'a SIGKILL (137)', exitCode: SIGKILL_EXIT_CODE },
    { label: 'a failing exit code (2)', exitCode: 2 },
  ])('hook first, then $label by itself: one harness_exit closure and one error event', async ({ exitCode }) => {
    const { server, sessions, harness, clock } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.nowMs += EARLY_EXIT_WINDOW_MS + 1;

    endSession(sessions, session.id);
    harness.handles[0]!.emitExit(exitCode);
    await waitFor(() => frames.find(isClosed));
    await settle();

    expect(frames.filter(isClosed)).toEqual([{ type: 'session.closed', sessionId: session.id, exitCode, reason: 'harness_exit' }]);
    expect(frames.filter(isError).map((frame) => errorOf(frame).error)).toEqual(['harness_exited']);
  });

  it('exit first, then the hook: the exit alone decides, and the late hook adds neither a closure nor an error', async () => {
    const { server, sessions, harness, clock } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.nowMs += EARLY_EXIT_WINDOW_MS + 1;

    harness.handles[0]!.emitExit(SIGTERM_EXIT_CODE);
    await waitFor(() => frames.find(isClosed));
    endSession(sessions, session.id);
    await settle();

    expect(frames.filter(isClosed)).toEqual([{ type: 'session.closed', sessionId: session.id, exitCode: SIGTERM_EXIT_CODE, reason: 'harness_exit' }]);
    expect(frames.filter(isError)).toHaveLength(1);
  });

  it('a CLI that ends its session but hangs is killed by the daemon after the grace, and that kill is a closed_by_user with no error', async () => {
    const { server, sessions, harness } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);

    endSession(sessions, session.id);
    expect(harness.handles[0]!.killed).toBe(false);
    const closed = await waitFor(() => frames.find(isClosed));
    await settle();

    expect(harness.handles[0]!.killed).toBe(true);
    expect(closed).toEqual({ type: 'session.closed', sessionId: session.id, exitCode: SIGKILL_EXIT_CODE, reason: 'closed_by_user' });
    expect(frames.filter(isError)).toEqual([]);
  });

  it('no SessionEnd at all: a signal exit is a harness_exit, and a clean exit carries no reason', async () => {
    const { server, sessions, harness, clock } = await boot();
    const crashed = await sessions.create(spec);
    const quit = await sessions.create(spec);
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.nowMs += EARLY_EXIT_WINDOW_MS + 1;

    harness.handles[0]!.emitExit(SIGKILL_EXIT_CODE);
    harness.handles[1]!.emitExit(0);
    await waitFor(() => (frames.filter(isClosed).length >= 2 ? true : undefined));

    const closures = Object.fromEntries(frames.filter(isClosed).map((frame) => [frame.sessionId, frame.reason]));
    expect(closures).toEqual({ [crashed.id]: 'harness_exit', [quit.id]: undefined });
  });

  it('a user close during the grace wins: the daemon kill is closed_by_user, never a harness_exit', async () => {
    const { server, sessions } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);

    endSession(sessions, session.id);
    await sessions.close(session.id);
    await settle();

    expect(frames.filter(isClosed)).toEqual([{ type: 'session.closed', sessionId: session.id, exitCode: SIGKILL_EXIT_CODE, reason: 'closed_by_user' }]);
    expect(frames.filter(isError)).toEqual([]);
  });

  it('a /clear SessionEnd never closes the session, announces no error and never reports a harness_exit', async () => {
    const { server, sessions, harness } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);
    sessions.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionStart' } as never });

    endSession(sessions, session.id, { reason: 'clear' });
    await settle();

    expect(frames.filter(isClosed)).toEqual([]);
    expect(frames.filter(isError)).toEqual([]);
    expect(harness.handles[0]!.killed).toBe(false);
    expect(sessions.get(session.id)?.state).not.toBe('closed');
  });
});

describe('a daemon shutdown', () => {
  it('closes every session with the daemon_shutdown reason and announces no error', async () => {
    const { server, sessions } = await boot();
    await sessions.create(spec);
    await sessions.create(spec);
    const frames = await openClient(server);

    await sessions.closeAll();
    await waitFor(() => (frames.filter(isClosed).length >= 2 ? true : undefined));
    await settle();

    expect(frames.filter(isClosed).map((frame) => frame.reason)).toEqual(['daemon_shutdown', 'daemon_shutdown']);
    expect(frames.filter(isError)).toEqual([]);
  });

  it('cuts short a SessionEnd grace still running: the shutdown kills at once and the reason stays daemon_shutdown', async () => {
    const { server, sessions, harness } = await boot();
    const session = await sessions.create(spec);
    const frames = await openClient(server);

    endSession(sessions, session.id);
    await sessions.closeAll();
    await settle();

    expect(harness.handles[0]!.killed).toBe(true);
    expect(frames.filter(isClosed)).toEqual([{ type: 'session.closed', sessionId: session.id, exitCode: SIGKILL_EXIT_CODE, reason: 'daemon_shutdown' }]);
  });
});

describe('the harness_exited envelope', () => {
  it('names an exit right after launch and points at the CLI installation, without paths or tokens', async () => {
    const { server, sessions, harness } = await boot();
    await sessions.create({ ...spec, directory: '/tmp' });
    const frames = await openClient(server);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch = harness.launches[0]!;

    harness.handles[0]!.emitExit(1);
    const errorEvent = await waitFor(() => frames.find(isError));

    expect(errorOf(errorEvent)).toEqual({ error: 'harness_exited', kind: 'unavailable', retry: 'never',
      message: 'the agent process exited right after launch (exit code 1).', hint: 'Check that the claude CLI is installed and on the PATH the daemon runs with.' });
    const wire = JSON.stringify(errorEvent);
    expect(wire).not.toContain(launch.mcpToken);
    expect(wire).not.toContain(launch.hookUrl);
    expect(logged.mock.calls.filter((call) => call.some((part) => String(part).includes(launch.sessionId)))).toHaveLength(1);
  });

  it('an exit long after launch says the process exited and suggests reopening, with no PATH hint', async () => {
    const { server, sessions, harness, clock } = await boot();
    await sessions.create(spec);
    const frames = await openClient(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.nowMs += EARLY_EXIT_WINDOW_MS + 1;

    harness.handles[0]!.emitExit(2);
    const errorEvent = await waitFor(() => frames.find(isError));

    expect(errorOf(errorEvent)).toMatchObject({ message: 'the agent process exited (exit code 2).', hint: 'reopen the session to resume the conversation.' });
    expect(errorOf(errorEvent).id).toBeUndefined();
  });
});
