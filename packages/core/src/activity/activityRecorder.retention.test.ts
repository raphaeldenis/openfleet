import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ACTIVITY_RETENTION, ActivityRecorder } from './activityRecorder.js';
import { ActivityRepository } from './activityRepository.js';

const NOW = '2026-11-01T10:00:00.000Z';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MILLISECONDS = 5000;
// Cold measure: ~320 ms for the heaviest prune (120 000 rows removed). 5 s leaves room for a loaded machine
// (1859 ms seen at load 32) and still catches a quadratic sweep, which would take minutes at this size.
const MAX_BOOT_PRUNE_MILLISECONDS = 5000;
const LOG_OVER_THE_CAP = 150_000;

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const instantDaysAgo = (days: number) => new Date(Date.parse(NOW) - days * MILLISECONDS_PER_DAY).toISOString();

const openLogOnDisk = () => {
  const db = openDatabase(join(directories.make('activity-retention-'), 'openfleet.db'));
  return { db, repository: new ActivityRepository(db) };
};

const fillLog = ({ db, repository }: { db: DatabaseSync; repository: ActivityRepository }, rows: { count: number; at: (index: number) => string }) => {
  const argsExcerpt = 'x'.repeat(400);
  db.exec('BEGIN');
  for (let index = 0; index < rows.count; index += 1) {
    repository.insert({
      at: rows.at(index), actorKind: 'agent', actorLabel: 'Worker', sessionId: `session-${index % 50}`, managerId: `manager-${index % 5}`, source: 'mcp',
      action: 'create_note', outcome: 'ok', durationMs: 3, argsExcerpt,
    });
  }
  db.exec('COMMIT');
};

const rowCount = (db: DatabaseSync) => Number((db.prepare('SELECT COUNT(*) AS total FROM activity_log').get() as { total: number }).total);

const pruneAtBootTakingMilliseconds = (repository: ActivityRepository) => {
  const recorder = new ActivityRecorder({ repository, clock: () => NOW, onFailure: (error) => { throw error; } });
  const startedAt = performance.now();
  recorder.pruneAtBoot();
  return performance.now() - startedAt;
};

describe('the cost of pruning the activity log at boot', () => {
  it('stays within the boot budget, and under the busy timeout, when the log holds 150 000 rows and the cap removes 50 000', () => {
    const log = openLogOnDisk();
    fillLog(log, { count: LOG_OVER_THE_CAP, at: () => instantDaysAgo(1) });

    const milliseconds = pruneAtBootTakingMilliseconds(log.repository);

    console.info(`[activity retention] cap: pruned 50000 of ${LOG_OVER_THE_CAP} rows in ${milliseconds.toFixed(0)} ms (busy_timeout ${BUSY_TIMEOUT_MILLISECONDS} ms)`);
    expect(rowCount(log.db)).toBe(ACTIVITY_RETENTION.maxRows);
    expect(milliseconds).toBeLessThan(MAX_BOOT_PRUNE_MILLISECONDS);
    log.db.close();
  });

  it('stays within the boot budget when the log holds 120 000 rows past the maximum age and 30 000 fresh ones', () => {
    const log = openLogOnDisk();
    const PAST_THE_MAXIMUM_AGE_DAYS = ACTIVITY_RETENTION.maxAgeDays + 10;
    fillLog(log, { count: LOG_OVER_THE_CAP, at: (index) => instantDaysAgo(index < 120_000 ? PAST_THE_MAXIMUM_AGE_DAYS : 1) });

    const milliseconds = pruneAtBootTakingMilliseconds(log.repository);

    console.info(`[activity retention] age: pruned 120000 of ${LOG_OVER_THE_CAP} rows in ${milliseconds.toFixed(0)} ms (busy_timeout ${BUSY_TIMEOUT_MILLISECONDS} ms)`);
    expect(rowCount(log.db)).toBe(30_000);
    expect(milliseconds).toBeLessThan(MAX_BOOT_PRUNE_MILLISECONDS);
    log.db.close();
  });

  it('stays within the boot budget when the log is full and nothing is removed, which is the usual boot', () => {
    const log = openLogOnDisk();
    fillLog(log, { count: ACTIVITY_RETENTION.maxRows, at: () => instantDaysAgo(1) });

    const milliseconds = pruneAtBootTakingMilliseconds(log.repository);

    console.info(`[activity retention] steady: pruned nothing of ${ACTIVITY_RETENTION.maxRows} rows in ${milliseconds.toFixed(0)} ms`);
    expect(rowCount(log.db)).toBe(ACTIVITY_RETENTION.maxRows);
    expect(milliseconds).toBeLessThan(MAX_BOOT_PRUNE_MILLISECONDS);
    log.db.close();
  });
});
