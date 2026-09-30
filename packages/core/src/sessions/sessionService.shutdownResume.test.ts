import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { RESUME_LAUNCH_FAILED_EXIT_CODE, SessionService } from './sessionService.js';

// A daemon "boot" is a fresh SessionService over the same, already-populated database.
function bootDaemon(db: ReturnType<typeof openDatabase>) {
  const harness = new FakeHarness();
  const service = new SessionService({ db, bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
  return { harness, service };
}

const newSession = (service: SessionService, name: string, extra: { parentId?: string } = {}) =>
  service.create({ directory: '/tmp', name, harness: 'fake', emoji: '🤖', ...extra });

describe('sessions across a daemon restart', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resumes every session a graceful shutdown closed', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const lead = await newSession(first.service, 'Lead');
    const worker = await newSession(first.service, 'Worker', { parentId: lead.id });
    const otherWorker = await newSession(first.service, 'Other', { parentId: lead.id });
    await first.service.closeAll();

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([lead.id, worker.id, otherWorker.id]);
    expect(second.harness.launches.every((launch) => launch.resuming)).toBe(true);
    expect([lead.id, worker.id, otherWorker.id].map((id) => second.service.get(id)!.state)).toEqual(['starting', 'starting', 'starting']);
  });

  it('resumes two managers and their children, each manager before its children', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const managerA = await newSession(first.service, 'Manager A');
    const managerB = await newSession(first.service, 'Manager B');
    const childOfA = await newSession(first.service, 'Child A', { parentId: managerA.id });
    const childOfB = await newSession(first.service, 'Child B', { parentId: managerB.id });
    await first.service.closeAll();

    const second = bootDaemon(db);
    await second.service.resumeAll();

    const resumedIds = second.harness.launches.map((launch) => launch.sessionId);
    expect(resumedIds).toHaveLength(4);
    expect(resumedIds.indexOf(managerA.id)).toBeLessThan(resumedIds.indexOf(childOfA.id));
    expect(resumedIds.indexOf(managerB.id)).toBeLessThan(resumedIds.indexOf(childOfB.id));
  });

  it('resumes 50 sessions in one pass, one launch each', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    for (let index = 0; index < 50; index += 1) await newSession(first.service, `Worker ${index}`);
    await first.service.closeAll();

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(50);
    expect(new Set(second.harness.launches.map((launch) => launch.sessionId)).size).toBe(50);
  });

  it('keeps closed a session whose user close was in flight when the shutdown began', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    const userClose = first.service.close(session.id);
    await first.service.closeAll();
    await userClose;

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
    expect(second.service.get(session.id)!.state).toBe('closed');
  });

  it('does not resume a closed session whose shutdown event predates its latest close', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    db.prepare("UPDATE sessions SET closed_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(session.id);

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
  });

  it('keeps closed a session the user closed before the shutdown', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const closedByUser = await newSession(first.service, 'Closed by user');
    const stillOpen = await newSession(first.service, 'Still open');
    await first.service.close(closedByUser.id);
    await first.service.closeAll();

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([stillOpen.id]);
    expect(second.service.get(closedByUser.id)!.state).toBe('closed');
  });

  it('keeps closed a session the user closed after a resume that followed a shutdown', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    const second = bootDaemon(db);
    await second.service.resumeAll();
    vi.setSystemTime(Date.now() + 1000);
    await second.service.close(session.id);

    const third = bootDaemon(db);
    await third.service.resumeAll();

    expect(third.harness.launches).toHaveLength(0);
    expect(third.service.get(session.id)!.state).toBe('closed');
  });

  it('resumes the sessions of a daemon that was killed without a graceful close', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([session.id]);
    expect(second.service.get(session.id)!.state).toBe('starting');
  });

  it('closes with the launch-failed exit code a session whose resume fails, and does not retry it at the next boot', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    vi.setSystemTime(Date.now() + 1000);
    const second = bootDaemon(db);
    vi.spyOn(second.harness, 'start').mockImplementation(() => { throw new Error('cannot spawn'); });
    await second.service.resumeAll();

    const third = bootDaemon(db);
    await third.service.resumeAll();

    expect(second.service.get(session.id)!.state).toBe('closed');
    expect(second.service.get(session.id)!.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    expect(third.harness.launches).toHaveLength(0);
  });
});
