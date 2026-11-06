import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { cpuMillisecondsOf } from '../__testing__/linearGrowth.js';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ACTIVITY_RETENTION, ActivityRecorder } from './activityRecorder.js';
import { ActivityRepository } from './activityRepository.js';

const NOW = '2026-11-01T10:00:00.000Z';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const STATEMENTS_OF_A_PRUNE = 2;
// CPU time, which the slices given to other processes do not stretch. About 320 ms for the heaviest prune (120 000 rows removed);
// 5 s of CPU still catches a quadratic sweep, which takes minutes at this size.
const MAX_BOOT_PRUNE_CPU_MILLISECONDS = 5000;
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

/** The database seen through a counter of the statements run on it: a prune that deletes row by row runs thousands. */
const withStatementRunsCounted = (db: DatabaseSync) => {
  let statementRuns = 0;
  const countingDb = {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return { run: (...values: SQLInputValue[]) => { statementRuns += 1; return statement.run(...values); } };
    },
  } as unknown as DatabaseSync;
  return { countingDb, statementRuns: () => statementRuns };
};

const pruneAtBoot = (db: DatabaseSync) => {
  const { countingDb, statementRuns } = withStatementRunsCounted(db);
  const recorder = new ActivityRecorder({ repository: new ActivityRepository(countingDb), clock: () => NOW, onFailure: (error) => { throw error; } });
  const cpuMilliseconds = cpuMillisecondsOf(() => recorder.pruneAtBoot());
  return { cpuMilliseconds, statementRuns: statementRuns() };
};

describe('the cost of pruning the activity log at boot', () => {
  it('prunes with a fixed number of statements, within the CPU budget, when the log holds 150 000 rows and the cap removes 50 000', () => {
    const log = openLogOnDisk();
    fillLog(log, { count: LOG_OVER_THE_CAP, at: () => instantDaysAgo(1) });

    const { cpuMilliseconds, statementRuns } = pruneAtBoot(log.db);

    expect(rowCount(log.db)).toBe(ACTIVITY_RETENTION.maxRows);
    expect(statementRuns).toBe(STATEMENTS_OF_A_PRUNE);
    expect(cpuMilliseconds).toBeLessThan(MAX_BOOT_PRUNE_CPU_MILLISECONDS);
    log.db.close();
  });

  it('prunes with a fixed number of statements, within the CPU budget, when the log holds 120 000 rows past the maximum age and 30 000 fresh ones', () => {
    const log = openLogOnDisk();
    const PAST_THE_MAXIMUM_AGE_DAYS = ACTIVITY_RETENTION.maxAgeDays + 10;
    fillLog(log, { count: LOG_OVER_THE_CAP, at: (index) => instantDaysAgo(index < 120_000 ? PAST_THE_MAXIMUM_AGE_DAYS : 1) });

    const { cpuMilliseconds, statementRuns } = pruneAtBoot(log.db);

    expect(rowCount(log.db)).toBe(30_000);
    expect(statementRuns).toBe(STATEMENTS_OF_A_PRUNE);
    expect(cpuMilliseconds).toBeLessThan(MAX_BOOT_PRUNE_CPU_MILLISECONDS);
    log.db.close();
  });

  it('prunes with a fixed number of statements, within the CPU budget, when the log is full and nothing is removed, which is the usual boot', () => {
    const log = openLogOnDisk();
    fillLog(log, { count: ACTIVITY_RETENTION.maxRows, at: () => instantDaysAgo(1) });

    const { cpuMilliseconds, statementRuns } = pruneAtBoot(log.db);

    expect(rowCount(log.db)).toBe(ACTIVITY_RETENTION.maxRows);
    expect(statementRuns).toBe(STATEMENTS_OF_A_PRUNE);
    expect(cpuMilliseconds).toBeLessThan(MAX_BOOT_PRUNE_CPU_MILLISECONDS);
    log.db.close();
  });
});
