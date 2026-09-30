import type { ServerEvent } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { SessionService } from './sessionService.js';

const START_TIMEOUT_MS = 25;
const WAIT_PAST_START_TIMEOUT_MS = 60;
const SIGTERM_EXIT_CODE = 143;
const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

type Database = ReturnType<typeof openDatabase>;
type StartRoute = 'create' | 'reopen' | 'resume';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bootDaemon(db: Database) {
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError,
    firstStartTimeoutMs: START_TIMEOUT_MS, resumeTimeoutMs: START_TIMEOUT_MS });
  return { harness, service, events };
}

// Leaves one session in `starting` on the requested route, its handle deaf to a graceful kill, its start timeout armed.
async function startingSessionOn(route: StartRoute) {
  const db = openDatabase(':memory:');
  const first = bootDaemon(db);
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
