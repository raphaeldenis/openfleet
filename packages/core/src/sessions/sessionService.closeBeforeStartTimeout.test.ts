import type { ServerEvent } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { SessionRepository } from './sessionRepository.js';
import { RESUME_LAUNCH_FAILED_EXIT_CODE, SessionService, type SessionServiceDeps } from './sessionService.js';

const START_TIMEOUT_MS = 25;
const WAIT_PAST_START_TIMEOUT_MS = 60;
const SIGTERM_EXIT_CODE = 143;
const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

type Database = ReturnType<typeof openDatabase>;
type StartRoute = 'create' | 'reopen' | 'resume';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bootDaemon(db: Database, overrides: Partial<SessionServiceDeps> = {}) {
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError,
    firstStartTimeoutMs: START_TIMEOUT_MS, resumeTimeoutMs: START_TIMEOUT_MS, ...overrides });
  return { harness, service, events };
}

// Leaves one session in `starting` on the requested route, its handle deaf to a graceful kill, its start timeout armed.
async function startingSessionOn(route: StartRoute, overrides: Partial<SessionServiceDeps> = {}) {
  const db = openDatabase(':memory:');
  const first = bootDaemon(db, overrides);
  const session = await first.service.create(spec);
  if (route === 'create') return { db, daemon: first, sessionId: session.id, handle: first.harness.handles[0]! };
  if (route === 'reopen') {
    await first.service.close(session.id);
    first.service.reopen(session.id);
    return { db, daemon: first, sessionId: session.id, handle: first.harness.handles[1]! };
  }
  const second = bootDaemon(db);
  await second.service.resumeAll();
  return { db, daemon: second, sessionId: session.id, handle: second.harness.handles[0]! };
}

const shutdownMarkersOf = (db: Database, sessionId: string) =>
  (db.prepare("SELECT count(*) AS n FROM session_events WHERE session_id = ? AND kind = 'daemon_shutdown'").get(sessionId) as { n: number }).n;

async function letTheStartTimeoutPassThenExit(handle: FakeHandle): Promise<void> {
  await sleep(WAIT_PAST_START_TIMEOUT_MS);
  handle.emitExit(SIGTERM_EXIT_CODE);
}

describe.each<StartRoute>(['create', 'reopen', 'resume'])('a close requested before the start timeout, on the %s route', (route) => {
  it('user close: the close owns the result, with one kill and no resume_timeout error', async () => {
    const { daemon, sessionId, handle } = await startingSessionOn(route);
    handle.ignoresGracefulKill = true;

    const closing = daemon.service.close(sessionId);
    await letTheStartTimeoutPassThenExit(handle);
    await closing;

    expect(daemon.events.filter((event) => event.type === 'session.closed').at(-1)).toMatchObject({ reason: 'closed_by_user' });
    expect(daemon.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(handle.killCount).toBe(1);
  });

  it('parent close: the close owns the result, with one kill and no resume_timeout error', async () => {
    const { daemon, sessionId, handle } = await startingSessionOn(route);
    handle.ignoresGracefulKill = true;

    const closing = daemon.service.close(sessionId, { closedByParent: true });
    await letTheStartTimeoutPassThenExit(handle);
    await closing;

    expect(daemon.events.filter((event) => event.type === 'session.closed').at(-1)).toMatchObject({ reason: 'closed_by_user' });
    expect(daemon.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(handle.killCount).toBe(1);
  });

  it('shutdown: closes as daemon_shutdown with one kill, writes the marker, and the next boot resumes it once', async () => {
    const { db, daemon, sessionId, handle } = await startingSessionOn(route);
    handle.ignoresGracefulKill = true;

    const closing = daemon.service.closeAll();
    await letTheStartTimeoutPassThenExit(handle);
    await closing;

    expect(daemon.events.filter((event) => event.type === 'session.closed').at(-1)).toMatchObject({ reason: 'daemon_shutdown' });
    expect(daemon.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(handle.killCount).toBe(1);
    expect(shutdownMarkersOf(db, sessionId)).toBe(1);
    const nextBoot = bootDaemon(db);
    await nextBoot.service.resumeAll();
    expect(nextBoot.harness.launches.map((launch) => launch.sessionId)).toEqual([sessionId]);
  });
});

describe('a SessionEnd received while the session is still starting', () => {
  it('leaves the close to the daemon: one closed_by_user exit, one kill, and no resume_timeout', async () => {
    const SESSION_END_GRACE_MS = 100;
    const { daemon, sessionId, handle } = await startingSessionOn('create', { sessionEndExitGraceMs: SESSION_END_GRACE_MS });
    handle.ignoresGracefulKill = true;

    daemon.service.applyInput(sessionId, { kind: 'hook', event: { hook_event_name: 'SessionEnd', session_id: sessionId } });
    await sleep(SESSION_END_GRACE_MS + WAIT_PAST_START_TIMEOUT_MS);
    handle.emitExit(SIGTERM_EXIT_CODE);
    await sleep(0);

    expect(daemon.events.filter((event) => event.type === 'session.closed')).toMatchObject([{ exitCode: SIGTERM_EXIT_CODE, reason: 'closed_by_user' }]);
    expect(daemon.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(handle.killCount).toBe(1);
  });
});

describe('a daemon shutdown that lands while a failed resume kills its process', () => {
  it('closes the row launch_failed without a shutdown marker, so the next boot does not retry it', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await first.service.create(spec);
    first.service.applyInput(session.id, { kind: 'hook', event: { hook_event_name: 'SessionStart', session_id: session.id } });
    const resumingDaemon = bootDaemon(db, { resumeTimeoutMs: 5000 });
    const realSetState = SessionRepository.prototype.setState;
    const setState = vi.spyOn(SessionRepository.prototype, 'setState').mockImplementation(function (this: SessionRepository, ...args) {
      if (args[1] === 'starting') throw new Error('synthetic db write failure');
      return realSetState.apply(this, args);
    });
    const realStart = resumingDaemon.harness.start.bind(resumingDaemon.harness);
    vi.spyOn(resumingDaemon.harness, 'start').mockImplementation((launch) => {
      const handle = realStart(launch);
      resumingDaemon.harness.handles.at(-1)!.ignoresGracefulKill = true;
      return handle;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const resuming = resumingDaemon.service.resumeAll();
    await sleep(0);
    const closing = resumingDaemon.service.closeAll();
    await sleep(20);
    resumingDaemon.harness.handles[0]!.emitExit(SIGTERM_EXIT_CODE);
    await Promise.all([resuming, closing]);
    setState.mockRestore();

    expect(resumingDaemon.service.get(session.id)).toMatchObject({ state: 'closed', exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE });
    expect(resumingDaemon.events.filter((event) => event.type === 'session.closed')).toMatchObject([{ reason: 'launch_failed' }]);
    expect(shutdownMarkersOf(db, session.id)).toBe(0);
    const nextBoot = bootDaemon(db);
    await nextBoot.service.resumeAll();
    expect(nextBoot.harness.launches).toEqual([]);
  });
});

describe('a start timeout that won before any close', () => {
  it('still closes as resume_timeout with no shutdown marker when the shutdown comes after', async () => {
    const { db, daemon, sessionId, handle } = await startingSessionOn('create');
    handle.ignoresGracefulKill = true;
    await sleep(WAIT_PAST_START_TIMEOUT_MS);

    const closing = daemon.service.closeAll();
    handle.emitExit(SIGTERM_EXIT_CODE);
    await closing;

    expect(daemon.events.filter((event) => event.type === 'session.closed')).toMatchObject([{ reason: 'resume_timeout' }]);
    expect(shutdownMarkersOf(db, sessionId)).toBe(0);
  });
});
