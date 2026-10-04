import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from './sessionService.js';

type Db = ReturnType<typeof openDatabase>;

function bootDaemon(db: Db) {
  const harness = new FakeHarness();
  const service = new SessionService({ db, bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
  return { harness, service };
}

const newSession = (service: SessionService, name: string, directory = '/tmp') =>
  service.create({ directory, name, harness: 'fake', emoji: '🤖' });

const closedAtOf = (db: Db, id: string) => (db.prepare('SELECT closed_at AS closedAt FROM sessions WHERE id = ?').get(id) as { closedAt: string }).closedAt;
const setClosedAt = (db: Db, id: string, closedAt: string) => db.prepare('UPDATE sessions SET closed_at = ? WHERE id = ?').run(closedAt, id);
const shutdownEventsOf = (db: Db, id: string) => (db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND kind = 'daemon_shutdown'").get(id) as { n: number }).n;

describe('resume after a graceful shutdown, hostile cases', () => {
  let scratch: string;
  beforeEach(() => {
    vi.useFakeTimers();
    scratch = mkdtempSync(join(tmpdir(), 'of-shutdown-resume-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('resumes the sessions of a shutdown from a database file closed and reopened between the two boots', async () => {
    const file = join(scratch, 'openfleet.db');
    const firstDb = openDatabase(file);
    const first = bootDaemon(firstDb);
    const lead = await newSession(first.service, 'Lead');
    const worker = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    firstDb.close();

    const second = bootDaemon(openDatabase(file));
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([lead.id, worker.id]);
  });

  it('keeps closed a session whose user close was still waiting on a stubborn process when the shutdown began', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Stubborn');
    first.harness.handles[0]!.ignoresGracefulKill = true;

    const userClose = first.service.close(session.id);
    const shutdown = first.service.closeAll();
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([userClose, shutdown]);
    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
    expect(second.service.get(session.id)!.state).toBe('closed');
  });

  it('resumes a session whose model switch was relaunching it when the shutdown began', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Switching');
    first.harness.markPrompted(session.id);
    first.service.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionStart' } as never });
    first.harness.handles[0]!.ignoresGracefulKill = true;
    first.service.updateModel(session.id, 'claude-opus-5-5');

    const shutdown = first.service.closeAll();
    await vi.advanceTimersByTimeAsync(60_000);
    await shutdown;
    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([session.id]);
  });

  it('keeps closed a session whose closed_at is earlier than its shutdown event (clock stepped back)', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    setClosedAt(db, session.id, '1970-01-01T00:00:00.000Z');

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
  });

  it('keeps closed a session whose closed_at differs from its shutdown event by one millisecond', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    const shutdownInstant = new Date(closedAtOf(db, session.id));
    setClosedAt(db, session.id, new Date(shutdownInstant.getTime() + 1).toISOString());

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
  });

  it('resumes a shutdown-closed session at the next boot when the shutdown event cannot be written', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    db.exec("CREATE TRIGGER refuse_shutdown_events BEFORE INSERT ON session_events WHEN NEW.kind = 'daemon_shutdown' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await first.service.closeAll().catch(() => undefined);
    db.exec('DROP TRIGGER refuse_shutdown_events');

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([session.id]);
  });

  it('keeps one session failing to launch from blocking the others when its directory vanished between boots', async () => {
    const db = openDatabase(':memory:');
    const vanishingDirectory = join(scratch, 'vanishing');
    mkdirSync(vanishingDirectory);
    const first = bootDaemon(db);
    const orphan = await newSession(first.service, 'Orphan', vanishingDirectory);
    const healthy = await newSession(first.service, 'Healthy');
    await first.service.closeAll();
    rmSync(vanishingDirectory, { recursive: true });
    vi.setSystemTime(Date.now() + 1000);
    const second = bootDaemon(db);
    const realStart = second.harness.start.bind(second.harness);
    vi.spyOn(second.harness, 'start').mockImplementation((launch) => {
      if (!existsSync(launch.directory)) throw new Error(`spawn ENOENT: ${launch.directory}`);
      return realStart(launch);
    });

    await second.service.resumeAll();
    const third = bootDaemon(db);
    await third.service.resumeAll();

    expect(second.service.get(orphan.id)!.state).toBe('closed');
    expect(second.service.get(orphan.id)!.exitCode).toBeUndefined();
    expect(second.service.get(healthy.id)!.state).toBe('starting');
    expect(third.harness.launches.map((launch) => launch.sessionId)).toEqual([healthy.id]);
  });

  it('keeps at most one shutdown event per currently shutdown-closed session across 100 restarts', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    for (let restart = 0; restart < 100; restart += 1) {
      vi.setSystemTime(Date.now() + 1000);
      const next = bootDaemon(db);
      await next.service.resumeAll();
      vi.setSystemTime(Date.now() + 1000);
      await next.service.closeAll();
    }

    expect(shutdownEventsOf(db, session.id)).toBe(1);
  });

  it('deletes the shutdown event of a session that resumed', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();

    await bootDaemon(db).service.resumeAll();

    expect(shutdownEventsOf(db, session.id)).toBe(0);
  });

  it('keeps closed a shutdown-closed session the user closed while the boot was still resuming an earlier one', async () => {
    const db = openDatabase(':memory:');
    const vanishingDirectory = join(scratch, 'vanishing');
    mkdirSync(vanishingDirectory);
    const first = bootDaemon(db);
    await newSession(first.service, 'Orphan', vanishingDirectory);
    const waiting = await newSession(first.service, 'Waiting');
    await first.service.closeAll();
    rmSync(vanishingDirectory, { recursive: true });

    const second = bootDaemon(db);
    const boot = second.service.resumeAll();
    const userClose = second.service.close(waiting.id);
    await Promise.all([boot, userClose]);

    expect(second.harness.launches).toHaveLength(0);
    expect(second.service.get(waiting.id)!.state).toBe('closed');
    expect(shutdownEventsOf(db, waiting.id)).toBe(0);
  });

  it('keeps closed a session whose user close arrived after the shutdown had already begun closing it', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Stubborn');
    first.harness.handles[0]!.ignoresGracefulKill = true;

    const shutdown = first.service.closeAll();
    const userClose = first.service.close(session.id);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([userClose, shutdown]);
    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
    expect(second.service.get(session.id)!.state).toBe('closed');
  });

  it('resumes the children the shutdown closed while their manager, closed by the user before, stays closed (no cascade on a manager close)', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const manager = await first.service.create({ directory: '/tmp', name: 'Manager', harness: 'fake', emoji: '🤖', role: 'manager' });
    const child = await first.service.create({ directory: '/tmp', name: 'Child', harness: 'fake', emoji: '🤖', parentId: manager.id });
    await first.service.close(manager.id);
    const childStateAfterManagerClose = first.service.get(child.id)!.state;
    await first.service.closeAll();

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(childStateAfterManagerClose).toBe('starting');
    expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([child.id]);
    expect(second.service.get(manager.id)!.state).toBe('closed');
  });

  describe('the directory guards of reopen() apply to every resumed row', () => {
    it('closes a session whose directory was replaced by a symlink to another path, and resumes the others in order', async () => {
      const db = openDatabase(':memory:');
      const swappedDirectory = join(scratch, 'swapped');
      const elsewhere = join(scratch, 'elsewhere');
      mkdirSync(swappedDirectory);
      mkdirSync(elsewhere);
      const first = bootDaemon(db);
      const swapped = await newSession(first.service, 'Swapped', swappedDirectory);
      const before = await newSession(first.service, 'Before');
      const after = await newSession(first.service, 'After');
      await first.service.closeAll();
      rmSync(swappedDirectory, { recursive: true });
      symlinkSync(elsewhere, swappedDirectory);

      const second = bootDaemon(db);
      await second.service.resumeAll();
      const third = bootDaemon(db);
      await third.service.resumeAll();

      expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([before.id, after.id]);
      expect(second.service.get(swapped.id)!.state).toBe('closed');
      expect(second.service.get(swapped.id)!.exitCode).toBeUndefined();
      expect(third.harness.launches.map((launch) => launch.sessionId)).toEqual([before.id, after.id]);
    });

    it('closes a session whose directory became unreadable, and resumes the others in order', async () => {
      const db = openDatabase(':memory:');
      const lockedDirectory = join(scratch, 'locked');
      mkdirSync(lockedDirectory);
      const first = bootDaemon(db);
      const before = await newSession(first.service, 'Before');
      const locked = await newSession(first.service, 'Locked', lockedDirectory);
      const after = await newSession(first.service, 'After');
      await first.service.closeAll();
      chmodSync(lockedDirectory, 0o000);

      const second = bootDaemon(db);
      try {
        await second.service.resumeAll();
      } finally {
        chmodSync(lockedDirectory, 0o700);
      }

      expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([before.id, after.id]);
      expect(second.service.get(locked.id)!.state).toBe('closed');
      expect(second.service.get(locked.id)!.exitCode).toBeUndefined();
    });

    it('closes a session left open by a killed daemon whose directory vanished while the daemon was dead', async () => {
      const db = openDatabase(':memory:');
      const vanishingDirectory = join(scratch, 'vanishing');
      mkdirSync(vanishingDirectory);
      const first = bootDaemon(db);
      const orphan = await newSession(first.service, 'Orphan', vanishingDirectory);
      const healthy = await newSession(first.service, 'Healthy');
      rmSync(vanishingDirectory, { recursive: true });

      const second = bootDaemon(db);
      await second.service.resumeAll();

      expect(second.harness.launches.map((launch) => launch.sessionId)).toEqual([healthy.id]);
      expect(second.service.get(orphan.id)!.state).toBe('closed');
      expect(second.service.get(orphan.id)!.exitCode).toBeUndefined();
    });
  });

  it('keeps closed a session the user closed in the same millisecond as the resume that followed a shutdown', async () => {
    const db = openDatabase(':memory:');
    const first = bootDaemon(db);
    const session = await newSession(first.service, 'Worker');
    await first.service.closeAll();
    const second = bootDaemon(db);
    await second.service.resumeAll();
    await second.service.close(session.id);

    const third = bootDaemon(db);
    await third.service.resumeAll();

    expect(third.harness.launches).toHaveLength(0);
  });

  it('does not launch a shutdown-closed session into a directory that no longer exists', async () => {
    const db = openDatabase(':memory:');
    const vanishingDirectory = join(scratch, 'vanishing');
    mkdirSync(vanishingDirectory);
    const first = bootDaemon(db);
    const orphan = await newSession(first.service, 'Orphan', vanishingDirectory);
    await first.service.closeAll();
    rmSync(vanishingDirectory, { recursive: true });

    const second = bootDaemon(db);
    await second.service.resumeAll();

    expect(second.harness.launches).toHaveLength(0);
    expect(second.service.get(orphan.id)!.state).toBe('closed');
  });
});
