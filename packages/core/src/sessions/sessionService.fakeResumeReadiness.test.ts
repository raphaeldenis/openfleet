import type { ServerEvent } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import type { HarnessLaunch } from '../harness/harness.js';
import { SessionService } from './sessionService.js';

const RESUME_TIMEOUT_MS = 25;
const WAIT_PAST_RESUME_TIMEOUT_MS = 60;
const FLEET_SIZE = 6;
const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

type Database = ReturnType<typeof openDatabase>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bootDaemon(db: Database, { fakeReportsSessionStart }: { fakeReportsSessionStart: boolean }) {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let service: SessionService | undefined;
  const reportSessionStart = ({ sessionId }: HarnessLaunch) => {
    service!.applyInput(sessionId, { kind: 'hook', event: { hook_event_name: 'SessionStart', session_id: sessionId } });
  };
  const harness = new FakeHarness(fakeReportsSessionStart ? { reportSessionStart } : {});
  service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError,
    firstStartTimeoutMs: RESUME_TIMEOUT_MS, resumeTimeoutMs: RESUME_TIMEOUT_MS });
  return { harness, service, events };
}

async function fleetLeftOpenByACrashedDaemon(db: Database): Promise<string[]> {
  const crashedDaemon = bootDaemon(db, { fakeReportsSessionStart: false });
  const sessions = await Promise.all(Array.from({ length: FLEET_SIZE }, () => crashedDaemon.service.create(spec)));
  for (const { id } of sessions) crashedDaemon.service.applyInput(id, { kind: 'hook', event: { hook_event_name: 'SessionStart', session_id: id } });
  return sessions.map(({ id }) => id);
}

describe('boot resume of a fleet of fake sessions', () => {
  it('keeps every session idle and closes none as resume_timeout once the fake reports its SessionStart', async () => {
    const db = openDatabase(':memory:');
    const sessionIds = await fleetLeftOpenByACrashedDaemon(db);
    const rebootedDaemon = bootDaemon(db, { fakeReportsSessionStart: true });

    await rebootedDaemon.service.resumeAll();
    await sleep(WAIT_PAST_RESUME_TIMEOUT_MS);

    const closures = rebootedDaemon.events.filter((event) => event.type === 'session.closed');
    expect(closures).toEqual([]);
    expect(sessionIds.map((id) => rebootedDaemon.service.get(id)?.state)).toEqual(Array(FLEET_SIZE).fill('idle'));
  });

  it('does not report a SessionStart for a session created fresh: only a relaunch signals readiness', async () => {
    const db = openDatabase(':memory:');
    const daemon = bootDaemon(db, { fakeReportsSessionStart: true });

    const session = await daemon.service.create(spec);
    await sleep(0);

    expect(daemon.service.get(session.id)?.state).toBe('starting');
  });

  it('a plain fake that stays silent after a resume is closed as resume_timeout (the behavior the readiness report removes)', async () => {
    const db = openDatabase(':memory:');
    await fleetLeftOpenByACrashedDaemon(db);
    const rebootedDaemon = bootDaemon(db, { fakeReportsSessionStart: false });

    await rebootedDaemon.service.resumeAll();
    await sleep(WAIT_PAST_RESUME_TIMEOUT_MS);

    const reasons = rebootedDaemon.events.filter((event) => event.type === 'session.closed').map((event) => event.reason);
    expect(reasons).toEqual(Array(FLEET_SIZE).fill('resume_timeout'));
  });
});
