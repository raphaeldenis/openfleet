import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { FireLedger } from './fireLedger.js';
import { FIRE_PRUNE_BATCH_SIZE, FireRetention } from './fireRetention.js';
import { fireCount, forgottenFireIds, isoDaysBefore, leaveFires, leaveTrigger, NOW_ISO } from './fireRetention.testkit.js';

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const FIRES_IN_THE_TABLE = 100_000;
const FIRES_TO_FORGET = 70_000;
const FIRES_PROTECTED = 1_000;
const RETENTION_DAYS = 90;
// The bound that matters is the longest stretch the event loop is held: one batch, never the whole purge. The purge hands the loop back after every batch,
// so the longest gap between two turns of a probe is the duration of one 1000-row statement. The limit is far above what a batch costs and far below a purge in one go.
const LONGEST_STRETCH_HOLDING_THE_EVENT_LOOP_MILLISECONDS = 1_000;

const fireToLeave = (index: number) => {
  const isProtected = index < FIRES_PROTECTED;
  if (isProtected) return { ledgerState: 'needs_review' as const, settledAt: isoDaysBefore(500) };
  const isToForget = index < FIRES_PROTECTED + FIRES_TO_FORGET;
  return { ledgerState: 'completed' as const, settledAt: isoDaysBefore(isToForget ? 200 : 1) };
};

const retentionOn = (db: ReturnType<typeof openDatabase>) => new FireRetention({
  ledger: new FireLedger(db), clock: () => Date.parse(NOW_ISO), schedule: () => () => {}, retentionDays: RETENTION_DAYS, onFailure: (error) => { throw error; },
});

/** Turns of the event loop a purge lets through, and the longest time between two of them. */
const probeTheEventLoopDuring = async (purge: Promise<unknown>) => {
  let turns = 0;
  let longestStretchMilliseconds = 0;
  let isPurging = true;
  let previousTurnAt = performance.now();
  const turn = () => {
    const now = performance.now();
    longestStretchMilliseconds = Math.max(longestStretchMilliseconds, now - previousTurnAt);
    previousTurnAt = now;
    turns += 1;
    if (isPurging) setImmediate(turn);
  };
  setImmediate(turn);
  await purge;
  isPurging = false;
  return { turns, longestStretchMilliseconds };
};

describe('the cost of forgetting the events of the fire ledger', () => {
  it('forgets 70 000 of 100 000 events in bounded batches, keeps the protected ones and every row, and never holds the event loop for more than a batch', async () => {
    const db = openDatabase(join(directories.make('fire-retention-cost-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    leaveFires(db, triggerId, { *[Symbol.iterator]() { for (let index = 0; index < FIRES_IN_THE_TABLE; index += 1) yield fireToLeave(index); } });
    const retention = retentionOn(db);

    const startedAt = performance.now();
    const purge = retention.forgetOldEvents();
    const { turns, longestStretchMilliseconds } = await probeTheEventLoopDuring(purge);
    const report = await purge;
    const milliseconds = performance.now() - startedAt;

    console.info(`[fire retention] forgot ${report.forgotten} of ${FIRES_IN_THE_TABLE} events in ${report.batches} batches of ${FIRE_PRUNE_BATCH_SIZE}, ${milliseconds.toFixed(0)} ms, longest stretch holding the event loop ${longestStretchMilliseconds.toFixed(0)} ms`);
    const fullBatchesThenOneThatFindsNothingMore = Math.floor(FIRES_TO_FORGET / FIRE_PRUNE_BATCH_SIZE) + 1;
    expect(report).toEqual({ forgotten: FIRES_TO_FORGET, batches: fullBatchesThenOneThatFindsNothingMore });
    expect(forgottenFireIds(db)).toHaveLength(FIRES_TO_FORGET);
    expect(fireCount(db)).toBe(FIRES_IN_THE_TABLE);
    const turnsBetweenTwoBatches = report.batches - 1;
    expect(turns).toBeGreaterThanOrEqual(turnsBetweenTwoBatches);
    expect(longestStretchMilliseconds).toBeLessThan(LONGEST_STRETCH_HOLDING_THE_EVENT_LOOP_MILLISECONDS);
    db.close();
  });

  it('runs one batch and nothing else when the ledger holds nothing old, which is the usual boot', async () => {
    const db = openDatabase(join(directories.make('fire-retention-steady-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    leaveFires(db, triggerId, Array.from({ length: 5_000 }, () => ({ ledgerState: 'completed' as const, settledAt: isoDaysBefore(1) })));

    const report = await retentionOn(db).forgetOldEvents();

    expect(report).toEqual({ forgotten: 0, batches: 1 });
    expect(forgottenFireIds(db)).toEqual([]);
    db.close();
  });

  it('forgets nothing a second time: a ledger already forgotten costs one batch that finds nothing', async () => {
    const db = openDatabase(join(directories.make('fire-retention-twice-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    leaveFires(db, triggerId, Array.from({ length: 3_000 }, () => ({ ledgerState: 'completed' as const, settledAt: isoDaysBefore(200) })));
    const retention = retentionOn(db);
    await retention.forgetOldEvents();

    const secondReport = await retention.forgetOldEvents();

    expect(secondReport).toEqual({ forgotten: 0, batches: 1 });
    db.close();
  });
});
