import type { ServerEvent, SessionCloseReason } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService, type SessionServiceDeps } from './sessionService.js';

const START_TIMEOUT_MS = 25;
const WAIT_PAST_START_TIMEOUT_MS = 60;
const REAL_PROCESS_EXIT_CODE = 1;
const LEGACY_RESUME_TIMEOUT_EXIT_CODE = -1;
const LEGACY_LAUNCH_FAILED_EXIT_CODE = -2;
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
  return { harness, service, events, db };
}

const lastClosedEventOf = (events: ServerEvent[]) => events.filter((event) => event.type === 'session.closed').at(-1);

interface ClosedSession { service: SessionService; events: ServerEvent[]; sessionId: string }

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

const closedByFailedReopenOfAClosedRow = async (): Promise<ClosedSession> => {
  const db = openDatabase(':memory:');
  const first = bootDaemon(db);
  const { id } = await first.service.create(spec);
  await first.service.closeAll();
  const restarted = bootDaemon(db, { harnesses: [] });
  await restarted.service.resumeAll();
  return { service: restarted.service, events: restarted.events, sessionId: id };
};

const closedByHarnessExit = async (): Promise<ClosedSession> => {
  const { service, events, harness } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  harness.handles[0]!.emitExit(REAL_PROCESS_EXIT_CODE);
  return { service, events, sessionId: id };
};

const closedByUser = async (): Promise<ClosedSession> => {
  const { service, events } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  await service.close(id);
  return { service, events, sessionId: id };
};

const closedByDaemonShutdown = async (): Promise<ClosedSession> => {
  const { service, events } = bootDaemon(openDatabase(':memory:'));
  const { id } = await service.create(spec);
  await service.closeAll();
  return { service, events, sessionId: id };
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

const closesWithoutAProcessExit: [SessionCloseReason, () => Promise<ClosedSession>][] = [
  ['resume_timeout', closedByStartTimeout],
  ['launch_failed', closedByFailedResumeLaunch],
  ['launch_failed', closedByFailedReopenOfAClosedRow],
];

describe.each(closesWithoutAProcessExit)('a session closed with reason %s and no process exit', (reason, closeSession) => {
  it('stores no exit code, so no sentinel stands in for the missing one', async () => {
    const { service, sessionId } = await closeSession();

    const stored = service.get(sessionId);

    expect(stored).toMatchObject({ state: 'closed', closeReason: reason });
    expect(stored?.exitCode).toBeUndefined();
  });

  it('announces the reason without an exit code', async () => {
    const { events } = await closeSession();

    const announced = lastClosedEventOf(events);

    expect(announced).toMatchObject({ type: 'session.closed', reason });
    expect(announced).not.toHaveProperty('exitCode', expect.anything());
  });
});

describe('a session whose process exited', () => {
  it('keeps the real exit code next to the harness_exit reason, stored and announced', async () => {
    const { service, events, sessionId } = await closedByHarnessExit();

    expect(service.get(sessionId)).toMatchObject({ closeReason: 'harness_exit', exitCode: REAL_PROCESS_EXIT_CODE });
    expect(lastClosedEventOf(events)).toMatchObject({ reason: 'harness_exit', exitCode: REAL_PROCESS_EXIT_CODE });
  });

  it.each([
    ['closed_by_user', closedByUser],
    ['daemon_shutdown', closedByDaemonShutdown],
    ['conversation_not_found', closedByRefusedResume],
  ] as const)('never carries a negative exit code for reason %s', async (reason, closeSession) => {
    const { service, sessionId } = await closeSession();

    const stored = service.get(sessionId);

    expect(stored?.closeReason).toBe(reason);
    expect(stored?.exitCode === undefined || stored.exitCode >= 0).toBe(true);
  });
});

describe('a row stored before exit codes stopped encoding the close reason', () => {
  const storeLegacyClose = async ({ exitCode, closeReason }: { exitCode: number; closeReason: SessionCloseReason | null }) => {
    const { service, db } = bootDaemon(openDatabase(':memory:'));
    const { id } = await service.create(spec);
    await service.close(id);
    db.prepare('UPDATE sessions SET exit_code = ?, close_reason = ? WHERE id = ?').run(exitCode, closeReason, id);
    return { service, sessionId: id };
  };

  it.each([
    ['resume_timeout', LEGACY_RESUME_TIMEOUT_EXIT_CODE],
    ['launch_failed', LEGACY_LAUNCH_FAILED_EXIT_CODE],
  ] as const)('reads no exit code when the sentinel sits next to the stored %s reason', async (closeReason, exitCode) => {
    const { service, sessionId } = await storeLegacyClose({ exitCode, closeReason });

    expect(service.get(sessionId)).toMatchObject({ closeReason });
    expect(service.get(sessionId)?.exitCode).toBeUndefined();
  });

  it.each([LEGACY_RESUME_TIMEOUT_EXIT_CODE, LEGACY_LAUNCH_FAILED_EXIT_CODE])('keeps the sentinel %i when no reason was stored, for the desktop fallback', async (exitCode) => {
    const { service, sessionId } = await storeLegacyClose({ exitCode, closeReason: null });

    expect(service.get(sessionId)).toMatchObject({ exitCode, closeReason: undefined });
  });

  it('keeps the real exit code stored with harness_exit', async () => {
    const { service, sessionId } = await storeLegacyClose({ exitCode: REAL_PROCESS_EXIT_CODE, closeReason: 'harness_exit' });

    expect(service.get(sessionId)).toMatchObject({ exitCode: REAL_PROCESS_EXIT_CODE, closeReason: 'harness_exit' });
  });
});
