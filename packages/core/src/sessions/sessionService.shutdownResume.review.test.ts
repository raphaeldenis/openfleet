import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { RESUME_LAUNCH_FAILED_EXIT_CODE, RESUME_TIMEOUT_EXIT_CODE, SessionService } from './sessionService.js';

type Db = ReturnType<typeof openDatabase>;

function bootDaemon(db: Db, options: { resumeTimeoutMs?: number; clearFlushGraceMs?: number } = {}) {
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: Array<{ type: string; sessionId?: string; exitCode?: number; reason?: string }> = [];
  bus.subscribe((event) => events.push(event as never));
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 100_000, ...options });
  return { harness, service, events };
}

const rejectStartingTransitionOf = (db: Db, name: string) =>
  db.exec(`CREATE TRIGGER fail_start BEFORE UPDATE OF state ON sessions WHEN NEW.name = '${name}' AND NEW.state = 'starting' BEGIN SELECT RAISE(ABORT, 'injected per-row state failure'); END`);
const reopenedEventsOf = (db: Db, id: string) => (db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND kind = 'reopened'").get(id) as { n: number }).n;

const newSession = (service: SessionService, name: string, directory = '/tmp') =>
  service.create({ directory, name, harness: 'fake', emoji: '🤖' });
const shutdownEventsOf = (db: Db, id: string) => (db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND kind = 'daemon_shutdown'").get(id) as { n: number }).n;

describe('resume after a graceful shutdown, adversarial review findings', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps closed a session whose explicit close (user or parent) lands while the shutdown waits for its exit', async () => {
    for (const closeOptions of [undefined, { closedByParent: true }]) {
      const db = openDatabase(':memory:');
      const first = bootDaemon(db);
      const session = await newSession(first.service, 'Stubborn');
      first.harness.handles[0]!.ignoresGracefulKill = true;

      const shutdown = first.service.closeAll();
      const explicitClose = first.service.close(session.id, closeOptions);
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all([shutdown, explicitClose]);
      const second = bootDaemon(db);
      await second.service.resumeAll();

      expect(second.harness.launches).toHaveLength(0);
      expect(shutdownEventsOf(db, session.id)).toBe(0);
    }
  });

  it('consumes the shutdown marker when a manual reopen succeeds', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    const second = bootDaemon(db);

    second.service.reopen(session.id);

    expect(shutdownEventsOf(db, session.id)).toBe(0);
  });

  it('closes with a fresh launch-failure exit, no marker and no boot resume when a manual reopen of a shutdown-closed row fails to launch', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    const second = bootDaemon(db);
    second.harness.start = () => { throw new Error('injected launch failure'); };

    expect(() => second.service.reopen(session.id)).toThrow();
    const third = bootDaemon(db);
    await third.service.resumeAll();

    expect(second.service.get(session.id)!.state).toBe('closed');
    expect(second.service.get(session.id)!.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    expect(shutdownEventsOf(db, session.id)).toBe(0);
    expect(third.harness.launches).toHaveLength(0);
  });

  it('resumes the healthy rows and finalizes as a failed resume the row whose starting transition fails', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const broken = await newSession(first.service, 'bad transition');
    const healthy = await newSession(first.service, 'healthy');
    await first.service.closeAll();
    const closedAtBeforeBoot = first.service.get(broken.id)!.closedAt;
    rejectStartingTransitionOf(db, 'bad transition');
    await vi.advanceTimersByTimeAsync(10);
    const second = bootDaemon(db);

    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([healthy.id]);
    expect(second.service.get(broken.id)!.state).toBe('closed');
    expect(second.service.get(broken.id)!.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    expect(second.service.get(broken.id)!.closedAt).not.toBe(closedAtBeforeBoot);
    expect(shutdownEventsOf(db, broken.id)).toBe(0);
    expect(second.events).toContainEqual(expect.objectContaining({ type: 'session.closed', sessionId: broken.id, exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed' }));

    db.exec('DROP TRIGGER fail_start');
    const third = bootDaemon(db);
    await third.service.resumeAll();
    expect(third.harness.launches.map((launch) => launch.sessionId)).not.toContain(broken.id);
  });

  it('keeps resuming the healthy rows when the failure finalization of the broken row also fails to write', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    await newSession(first.service, 'bad transition');
    const healthy = await newSession(first.service, 'healthy');
    await first.service.closeAll();
    rejectStartingTransitionOf(db, 'bad transition');
    db.exec("CREATE TRIGGER fail_finalize BEFORE UPDATE OF exit_code ON sessions WHEN NEW.name = 'bad transition' BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END");
    const second = bootDaemon(db);

    await expect(second.service.resumeAll()).resolves.toBeUndefined();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([healthy.id]);
  });

  it('leaves no reopened event when the manual reopen of a shutdown-closed row fails its starting transition', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'bad transition');
    await first.service.closeAll();
    rejectStartingTransitionOf(db, 'bad transition');
    const second = bootDaemon(db);

    expect(() => second.service.reopen(session.id)).toThrow();
    expect(() => second.service.reopen(session.id)).toThrow();

    expect(reopenedEventsOf(db, session.id)).toBe(0);
  });

  it('ends a resume timeout that overlaps the shutdown as a plain close that no next boot resumes', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Never ready');
    await first.service.closeAll();
    const second = bootDaemon(db, { resumeTimeoutMs: 1 });
    await second.service.resumeAll();
    second.harness.handles[0]!.ignoresGracefulKill = true;
    await vi.advanceTimersByTimeAsync(5);

    const shutdown = second.service.closeAll();
    second.harness.handles[0]!.emitExit(137);
    await shutdown;
    await vi.advanceTimersByTimeAsync(0);
    const third = bootDaemon(db);
    await third.service.resumeAll();

    expect(second.service.get(session.id)!.exitCode).toBe(RESUME_TIMEOUT_EXIT_CODE);
    expect(shutdownEventsOf(db, session.id)).toBe(0);
    expect(third.harness.launches).toHaveLength(0);
  });

  it('resumes a session whose process exits while the shutdown waits for the flush of a /clear', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db, { clearFlushGraceMs: 60_000 });
    const session = await newSession(first.service, 'Clearing');
    first.service.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionStart', source: 'clear' } as never });
    first.service.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionEnd', reason: 'clear' } as never });

    const shutdown = first.service.closeAll();
    first.harness.handles[0]!.emitExit(137);
    await vi.advanceTimersByTimeAsync(60_000);
    await shutdown;
    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([session.id]);
  });

  it('closes a legacy row without a recorded realpath in a symlinked directory at boot (accepted fail-closed upgrade policy)', async () => {
    const db = openDatabase(':memory:');
    const scratch = mkdtempSync(join(tmpdir(), 'of-legacy-symlink-'));
    try {
      const realDirectory = join(scratch, 'real');
      const symlinkedDirectory = join(scratch, 'link');
      mkdirSync(realDirectory);
      symlinkSync(realDirectory, symlinkedDirectory);
      const first = bootDaemon(db);
      const session = await newSession(first.service, 'Legacy', symlinkedDirectory);
      await first.service.closeAll();
      db.prepare('UPDATE sessions SET directory_realpath = NULL WHERE id = ?').run(session.id);

      const second = bootDaemon(db);
      await second.service.resumeAll();

      expect(second.harness.launches).toHaveLength(0);
      expect(second.service.get(session.id)!.state).toBe('closed');
      expect(second.service.get(session.id)!.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
