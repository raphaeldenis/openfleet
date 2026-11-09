import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { FireLedger } from './fireLedger.js';
import { FIRE_PRUNE_BATCH_SIZE, FireRetention, type LetTheEventLoopRun } from './fireRetention.js';
import { fireCount, forgottenFireIds, isoDaysBefore, leaveFires, leaveTrigger, NOW_ISO } from './fireRetention.testkit.js';

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const FIRES_IN_THE_TABLE = 10_000;
const FIRES_TO_FORGET = 7_000;
const FIRES_PROTECTED = 100;
const RETENTION_DAYS = 90;

const fireToLeave = (index: number) => {
  const isProtected = index < FIRES_PROTECTED;
  if (isProtected) return { ledgerState: 'needs_review' as const, settledAt: isoDaysBefore(500) };
  const isToForget = index < FIRES_PROTECTED + FIRES_TO_FORGET;
  return { ledgerState: 'completed' as const, settledAt: isoDaysBefore(isToForget ? 200 : 1) };
};

const retentionOn = (db: ReturnType<typeof openDatabase>, { ledger = new FireLedger(db), letTheEventLoopRun }: { ledger?: Pick<FireLedger, 'forgetSettledEvents'>; letTheEventLoopRun?: LetTheEventLoopRun } = {}) => new FireRetention({
  ledger, clock: () => Date.parse(NOW_ISO), schedule: () => () => {}, retentionDays: RETENTION_DAYS, onFailure: (error) => { throw error; }, letTheEventLoopRun,
});

/** A purge whose every batch and every hand-back of the event loop is written down, in the order they happen. */
const observedPurgeOn = (db: ReturnType<typeof openDatabase>) => {
  const ledger = new FireLedger(db);
  const requestedBatchSizes: number[] = [];
  const forgottenPerBatch: number[] = [];
  const batchesDoneAtEachHandBack: number[] = [];
  const observedLedger: Pick<FireLedger, 'forgetSettledEvents'> = {
    forgetSettledEvents: (input) => {
      const batch = ledger.forgetSettledEvents(input);
      requestedBatchSizes.push(input.batchSize);
      forgottenPerBatch.push(batch.forgotten);
      return batch;
    },
  };
  const letTheEventLoopRun: LetTheEventLoopRun = async () => { batchesDoneAtEachHandBack.push(forgottenPerBatch.length); };
  return { retention: retentionOn(db, { ledger: observedLedger, letTheEventLoopRun }), requestedBatchSizes, forgottenPerBatch, batchesDoneAtEachHandBack };
};

/** Turns of the real event loop a purge lets through. */
const countTurnsOfTheEventLoopDuring = async (purge: Promise<unknown>) => {
  let turns = 0;
  let isPurging = true;
  const turn = () => {
    turns += 1;
    if (isPurging) setImmediate(turn);
  };
  setImmediate(turn);
  await purge;
  isPurging = false;
  return turns;
};

describe('the cost of forgetting the events of the fire ledger', () => {
  it('forgets 7 000 of 10 000 events in bounded batches, hands the event loop back after every batch, keeps the protected ones and every row', async () => {
    const db = openDatabase(join(directories.make('fire-retention-cost-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    leaveFires(db, triggerId, { *[Symbol.iterator]() { for (let index = 0; index < FIRES_IN_THE_TABLE; index += 1) yield fireToLeave(index); } });
    const purge = observedPurgeOn(db);

    const report = await purge.retention.forgetOldEvents();

    const fullBatchesThenOneThatFindsNothingMore = Math.floor(FIRES_TO_FORGET / FIRE_PRUNE_BATCH_SIZE) + 1;
    const everyBatchIsFollowedByAHandBack = Array.from({ length: fullBatchesThenOneThatFindsNothingMore }, (_, batchIndex) => batchIndex + 1);
    expect(report).toEqual({ forgotten: FIRES_TO_FORGET, batches: fullBatchesThenOneThatFindsNothingMore });
    expect(purge.requestedBatchSizes.every((size) => size === FIRE_PRUNE_BATCH_SIZE)).toBe(true);
    expect(Math.max(...purge.forgottenPerBatch)).toBe(FIRE_PRUNE_BATCH_SIZE);
    expect(purge.batchesDoneAtEachHandBack).toEqual(everyBatchIsFollowedByAHandBack);
    expect(forgottenFireIds(db)).toHaveLength(FIRES_TO_FORGET);
    expect(fireCount(db)).toBe(FIRES_IN_THE_TABLE);
    db.close();
  });

  it('lets the real event loop turn between two batches', async () => {
    const db = openDatabase(join(directories.make('fire-retention-loop-'), 'openfleet.db'));
    const triggerId = leaveTrigger(db);
    const batches = 4;
    leaveFires(db, triggerId, Array.from({ length: batches * FIRE_PRUNE_BATCH_SIZE - 1 }, () => ({ ledgerState: 'completed' as const, settledAt: isoDaysBefore(200) })));
    const purge = retentionOn(db).forgetOldEvents();

    const turns = await countTurnsOfTheEventLoopDuring(purge);

    const report = await purge;
    const turnsBetweenTwoBatches = report.batches - 1;
    expect(report.batches).toBe(batches);
    expect(turns).toBeGreaterThanOrEqual(turnsBetweenTwoBatches);
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
