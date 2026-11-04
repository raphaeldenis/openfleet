import { join } from 'node:path';
import type { TriggerLedgerState } from '@openfleet/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { FireLedger } from './fireLedger.js';
import { fireCount, forgottenFireIds, isoDaysBefore, leaveFires, leaveTrigger, remainingFireIds, type FireToLeave } from './fireRetention.testkit.js';

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const BATCH_SIZE = 10;
const FROM_THE_START = 0;
const LONG_AGO = isoDaysBefore(400);
const settledLongAgo = (ledgerState: TriggerLedgerState): FireToLeave => ({ ledgerState, settledAt: LONG_AGO });
const forgetBefore90Days = (ledger: FireLedger, options: { afterRowid?: number; batchSize?: number } = {}) =>
  ledger.forgetSettledEvents({ settledBefore: isoDaysBefore(90), afterRowid: options.afterRowid ?? FROM_THE_START, batchSize: options.batchSize ?? BATCH_SIZE });

const ledgerOnARealDatabase = () => {
  const db = openDatabase(join(directories.make('fire-ledger-retention-'), 'openfleet.db'));
  const triggerId = leaveTrigger(db);
  return { db, triggerId, ledger: new FireLedger(db) };
};

describe('forgetting the events of the fires that ended before an instant', () => {
  it('empties the event of the completed and the cancelled fires and keeps their rows', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const ids = leaveFires(db, triggerId, [settledLongAgo('completed'), settledLongAgo('cancelled')]);

    const { forgotten } = forgetBefore90Days(ledger);

    expect(forgotten).toBe(2);
    expect(remainingFireIds(db)).toEqual(ids);
    expect(forgottenFireIds(db)).toEqual(ids);
  });

  it('keeps the dedup key, the state, the dates and the effect time of a forgotten fire, so that the key stays taken and a cooldown still counts it', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const [fireId] = leaveFires(db, triggerId, [settledLongAgo('completed')]);
    const before = db.prepare('SELECT trigger_id, dedup_key, ledger_state, fired_at, settled_at, effect_started_at, event_digest, chain_depth FROM trigger_fires WHERE id = ?').get(fireId!);

    forgetBefore90Days(ledger);

    expect(db.prepare('SELECT trigger_id, dedup_key, ledger_state, fired_at, settled_at, effect_started_at, event_digest, chain_depth FROM trigger_fires WHERE id = ?').get(fireId!)).toEqual(before);
    expect(ledger.latestReachedEffectAt({ triggerId, exceptId: 'another' })).toBe(LONG_AGO);
  });

  it('answers the same fire to a fire accepted again under the dedup key of a forgotten one', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const [fireId] = leaveFires(db, triggerId, [settledLongAgo('completed')]);
    forgetBefore90Days(ledger);

    const result = ledger.accept({ id: 'second', triggerId, dedupKey: `key-${fireId}`, firedAt: isoDaysBefore(0), eventDigest: 'digest', eventJson: '{"again":true}', chainDepth: 1 });

    expect(result.wasAccepted).toBe(false);
    expect(result.fire.id).toBe(fireId);
    expect(fireCount(db)).toBe(1);
  });

  it.each<TriggerLedgerState>(['needs_review', 'attempted', 'accepted'])('never forgets the event of a fire that is %s, however old', (ledgerState) => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    leaveFires(db, triggerId, [{ ledgerState, settledAt: LONG_AGO }]);

    const { forgotten } = forgetBefore90Days(ledger);

    expect(forgotten).toBe(0);
    expect(forgottenFireIds(db)).toEqual([]);
  });

  it('forgets only the fires that ended strictly before the instant', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const cutoff = isoDaysBefore(90);
    const [justBefore, atTheInstant, justAfter] = leaveFires(db, triggerId, [
      { ledgerState: 'completed', settledAt: '2026-08-06T09:59:59.999Z' },
      { ledgerState: 'completed', settledAt: cutoff },
      { ledgerState: 'completed', settledAt: '2026-08-06T10:00:00.001Z' },
    ]);

    forgetBefore90Days(ledger);

    expect(cutoff).toBe('2026-08-06T10:00:00.000Z');
    expect(forgottenFireIds(db)).toEqual([justBefore]);
    expect([atTheInstant, justAfter].every((id) => remainingFireIds(db).includes(id!))).toBe(true);
  });

  it('forgets at most one batch per call, says how many, and does not count a fire already forgotten', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    leaveFires(db, triggerId, Array.from({ length: 25 }, () => settledLongAgo('completed')));

    const forgottenPerCall: number[] = [];
    let afterRowid = FROM_THE_START;
    for (let call = 0; call < 4; call += 1) {
      const batch = forgetBefore90Days(ledger, { afterRowid });
      forgottenPerCall.push(batch.forgotten);
      afterRowid = batch.lastRowid;
    }

    expect(forgottenPerCall).toEqual([10, 10, 5, 0]);
    expect(forgetBefore90Days(ledger).forgotten).toBe(0);
    expect(forgottenFireIds(db)).toHaveLength(25);
  });

  it('forgets the oldest rows first, goes on after the row it stopped at, and skips the protected ones among them', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const ids = leaveFires(db, triggerId, [
      settledLongAgo('needs_review'), settledLongAgo('completed'), settledLongAgo('completed'), settledLongAgo('completed'),
    ]);

    const firstBatch = forgetBefore90Days(ledger, { batchSize: 2 });
    expect(forgottenFireIds(db)).toEqual([ids[1], ids[2]]);

    forgetBefore90Days(ledger, { batchSize: 2, afterRowid: firstBatch.lastRowid });
    expect(forgottenFireIds(db)).toEqual([ids[1], ids[2], ids[3]]);
  });

  it('leaves the fires before the given row alone', () => {
    const { db, triggerId, ledger } = ledgerOnARealDatabase();
    const ids = leaveFires(db, triggerId, [settledLongAgo('completed'), settledLongAgo('completed')]);
    const firstRowid = Number((db.prepare('SELECT rowid FROM trigger_fires WHERE id = ?').get(ids[0]!) as { rowid: number }).rowid);

    forgetBefore90Days(ledger, { afterRowid: firstRowid });

    expect(forgottenFireIds(db)).toEqual([ids[1]]);
  });
});
