import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { FireLedger } from './fireLedger.js';
import { FIRE_PRUNE_BATCH_SIZE, FireRetention } from './fireRetention.js';
import { fireCount, isoDaysBefore, leaveFires, leaveTrigger, NOW_ISO } from './fireRetention.testkit.js';

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const FIRES_IN_THE_TABLE = 100_000;
const FIRES_TO_REMOVE = 70_000;
const FIRES_PROTECTED = 1_000;
const RETENTION_DAYS = 90;
// The bound that matters is the number of batches: each is one short statement, so the write lock is never held for the whole purge.
// The wall clock only has to catch a purge that rescans the table for every row, which takes minutes at this size; it is not a performance claim.
const PATHOLOGICAL_PURGE_MILLISECONDS = 60_000;

const fireToLeave = (index: number) => {
  const isProtected = index < FIRES_PROTECTED;
  if (isProtected) return { ledgerState: 'needs_review' as const, settledAt: isoDaysBefore(500) };
  const isToRemove = index < FIRES_PROTECTED + FIRES_TO_REMOVE;
  return { ledgerState: 'completed' as const, settledAt: isoDaysBefore(isToRemove ? 200 : 1) };
};

describe('the cost of pruning the fire ledger at boot', () => {
  it('removes 70 000 of 100 000 fires in batches of the bounded size, and keeps the protected ones', () => {
    const db = openDatabase(join(directories.make('fire-retention-cost-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    leaveFires(db, triggerId, { *[Symbol.iterator]() { for (let index = 0; index < FIRES_IN_THE_TABLE; index += 1) yield fireToLeave(index); } });
    const retention = new FireRetention({ ledger: new FireLedger(db), clock: () => Date.parse(NOW_ISO), retentionDays: RETENTION_DAYS, onFailure: (error) => { throw error; } });

    const startedAt = performance.now();
    const report = retention.pruneAtBoot();
    const milliseconds = performance.now() - startedAt;

    console.info(`[fire retention] removed ${report.removed} of ${FIRES_IN_THE_TABLE} fires in ${report.batches} batches of ${FIRE_PRUNE_BATCH_SIZE}, ${milliseconds.toFixed(0)} ms`);
    const fullBatchesThenOneThatFindsNothingMore = Math.floor(FIRES_TO_REMOVE / FIRE_PRUNE_BATCH_SIZE) + 1;
    expect(report).toEqual({ removed: FIRES_TO_REMOVE, batches: fullBatchesThenOneThatFindsNothingMore });
    expect(fireCount(db)).toBe(FIRES_IN_THE_TABLE - FIRES_TO_REMOVE);
    expect(milliseconds).toBeLessThan(PATHOLOGICAL_PURGE_MILLISECONDS);
    db.close();
  });

  it('runs one batch and nothing else when the ledger holds nothing old, which is the usual boot', () => {
    const db = openDatabase(join(directories.make('fire-retention-steady-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    leaveFires(db, triggerId, Array.from({ length: 5_000 }, () => ({ ledgerState: 'completed' as const, settledAt: isoDaysBefore(1) })));
    const retention = new FireRetention({ ledger: new FireLedger(db), clock: () => Date.parse(NOW_ISO), retentionDays: RETENTION_DAYS, onFailure: (error) => { throw error; } });

    const report = retention.pruneAtBoot();

    expect(report).toEqual({ removed: 0, batches: 1 });
    expect(fireCount(db)).toBe(5_000);
    db.close();
  });
});
