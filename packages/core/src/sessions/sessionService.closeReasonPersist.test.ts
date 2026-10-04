import type { ServerEvent, SessionCloseReason } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService, type SessionServiceDeps } from './sessionService.js';

const START_TIMEOUT_MS = 25;
const WAIT_PAST_START_TIMEOUT_MS = 60;
const CLI_EXIT_CODE_OF_A_REFUSED_RESUME = 1;
const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

type Database = ReturnType<typeof openDatabase>;

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

const announcedReasonOf = (events: ServerEvent[]) => events.filter((event) => event.type === 'session.closed').map((event) => event.reason);

interface ClosedSession { service: SessionService; events: ServerEvent[]; sessionId: string }

const closedByUser = async (): Promise<ClosedSession> => {
  const { service, events } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  await service.close(id);
  return { service, events, sessionId: id };
};

const closedByHarnessExit = async (): Promise<ClosedSession> => {
  const { service, events, harness } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  harness.handles[0]!.emitExit(CLI_EXIT_CODE_OF_A_REFUSED_RESUME);
  return { service, events, sessionId: id };
};

const closedByDaemonShutdown = async (): Promise<ClosedSession> => {
  const { service, events } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  await service.closeAll();
  return { service, events, sessionId: id };
};

const closedByStartTimeout = async (): Promise<ClosedSession> => {
  const { service, events } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  await sleep(WAIT_PAST_START_TIMEOUT_MS);
  return { service, events, sessionId: id };
};

const closedByFailedResumeLaunch = async (): Promise<ClosedSession> => {
  const db = openDatabase(':memory:');
  const { id } = await bootDaemon(db).service.create(spec);
  const restarted = bootDaemon(db, { harnesses: [] });
  await restarted.service.resumeAll();
  return { service: restarted.service, events: restarted.events, sessionId: id };
};

const closedByRefusedResume = async (): Promise<ClosedSession> => {
  const { service, events, harness } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  harness.markPrompted(id);
  await service.close(id);
  harness.conversationsRefusedOnResume.add(id);
  service.reopen(id);
  await sleep(5);
  return { service, events, sessionId: id };
};

const closeScenarios: [SessionCloseReason, () => Promise<ClosedSession>][] = [
  ['closed_by_user', closedByUser],
  ['harness_exit', closedByHarnessExit],
  ['daemon_shutdown', closedByDaemonShutdown],
  ['resume_timeout', closedByStartTimeout],
  ['launch_failed', closedByFailedResumeLaunch],
  ['conversation_not_found', closedByRefusedResume],
];

describe.each(closeScenarios)('a session closed with reason %s', (reason, closeSession) => {
  it('carries the reason on the stored session, the same one the session.closed event announced', async () => {
    const { service, events, sessionId } = await closeSession();

    expect(service.get(sessionId)).toMatchObject({ state: 'closed', closeReason: reason });
    expect(announcedReasonOf(events).at(-1)).toBe(reason);
  });

  it('lists the reason, as a snapshot reads it', async () => {
    const { service, sessionId } = await closeSession();

    const listed = service.list().find((session) => session.id === sessionId);

    expect(listed?.closeReason).toBe(reason);
  });
});

describe('a closed session that comes back', () => {
  it('forgets the close reason as soon as the reopen starts', async () => {
    const { service, sessionId } = await closedByUser();

    service.reopen(sessionId);

    expect(service.get(sessionId)).toMatchObject({ state: 'starting', closeReason: undefined });
  });

  it('replaces the previous reason with the one of the next close', async () => {
    const { service, sessionId } = await closedByUser();
    service.reopen(sessionId);

    await service.close(sessionId);

    expect(service.get(sessionId)?.closeReason).toBe('closed_by_user');
  });

  it('forgets a daemon_shutdown reason when the next boot resumes the session', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const { id } = await first.service.create(spec);
    await first.service.closeAll();
    const nextBoot = bootDaemon(db);

    await nextBoot.service.resumeAll();

    expect(nextBoot.service.get(id)).toMatchObject({ state: 'starting', closeReason: undefined });
  });
});
