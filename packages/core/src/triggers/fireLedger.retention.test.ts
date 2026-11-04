import { join } from 'node:path';
import type { TriggerLedgerState } from '@openfleet/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { FireLedger } from './fireLedger.js';
import { fireCount, isoDaysBefore, leaveFires, leaveTrigger, remainingFireIds, type FireToLeave } from './fireRetention.testkit.js';

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const BATCH_SIZE = 10;
const LONG_AGO = isoDaysBefore(400);
const settledLongAgo = (ledgerState: TriggerLedgerState): FireToLeave => ({ ledgerState, settledAt: LONG_AGO });

const ledgerOnARealDatabase = () => {
  const db = openDatabase(join(directories.make('fire-ledger-retention-'), 'openfleet.db'));
  const triggerId = leaveTrigger(db);
  return { db, triggerId, ledger: new FireLedger(db) };
};

describe('pruning the fires that ended before an instant', () => {
  it('removes the completed and the cancelled fires that ended before the instant', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    leaveFires(db, triggerId, [settledLongAgo('completed'), settledLongAgo('cancelled')]);

    const removed = ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: BATCH_SIZE });

    expect(removed).toBe(2);
    expect(fireCount(db)).toBe(0);
  });

  it.each<TriggerLedgerState>(['needs_review', 'attempted', 'accepted'])('never removes a fire that is %s, however old', (ledgerState) => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const [protectedFireId] = leaveFires(db, triggerId, [{ ledgerState, settledAt: LONG_AGO }]);

    const removed = ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: BATCH_SIZE });

    expect(removed).toBe(0);
    expect(remainingFireIds(db)).toEqual([protectedFireId]);
  });

  it('removes only the fires that ended strictly before the instant', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const cutoff = isoDaysBefore(90);
    const [, atTheInstant, justAfter] = leaveFires(db, triggerId, [
      { ledgerState: 'completed', settledAt: '2026-08-06T09:59:59.999Z' },
      { ledgerState: 'completed', settledAt: cutoff },
      { ledgerState: 'completed', settledAt: '2026-08-06T10:00:00.001Z' },
    ]);

    ledger.pruneSettled({ settledBefore: cutoff, batchSize: BATCH_SIZE });

    expect(cutoff).toBe('2026-08-06T10:00:00.000Z');
    expect(remainingFireIds(db)).toEqual([atTheInstant, justAfter]);
  });

  it('removes at most one batch per call, and says how many it removed', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    leaveFires(db, triggerId, Array.from({ length: 25 }, () => settledLongAgo('completed')));

    const firstCall = ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: BATCH_SIZE });
    const secondCall = ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: BATCH_SIZE });
    const thirdCall = ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: BATCH_SIZE });
    const fourthCall = ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: BATCH_SIZE });

    expect([firstCall, secondCall, thirdCall, fourthCall]).toEqual([10, 10, 5, 0]);
    expect(fireCount(db)).toBe(0);
  });

  it('removes the oldest rows of the table first and keeps the protected ones among them', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const ids = leaveFires(db, triggerId, [
      settledLongAgo('needs_review'), settledLongAgo('completed'), settledLongAgo('completed'), settledLongAgo('completed'),
    ]);

    ledger.pruneSettled({ settledBefore: isoDaysBefore(90), batchSize: 2 });

    expect(remainingFireIds(db)).toEqual([ids[0], ids[3]]);
  });
});
