import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inTransaction } from './transaction.js';
import { openDatabase } from './database.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec('CREATE TABLE probe (label TEXT)');
});
afterEach(() => vi.restoreAllMocks());

const labels = () => (db.prepare('SELECT label FROM probe ORDER BY label').all() as { label: string }[]).map((row) => row.label);

/** Makes every ROLLBACK statement throw before it reaches sqlite, so the transaction stays open. */
function failEveryRollback(rollbackError: Error): void {
  const realExec = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    if (sql === 'ROLLBACK') throw rollbackError;
    return realExec(sql);
  });
}

describe('inTransaction when ROLLBACK itself fails', () => {
  it('rethrows the original error, never the rollback failure', () => {
    const original = new Error('work failed');
    failEveryRollback(new Error('rollback failed'));

    const run = () => inTransaction(db, 'sp', () => { throw original; });

    expect(run).toThrow(original);
  });

  it('commits the next call once the stuck transaction can be rolled back again', () => {
    const rollbackRefusal = new Error('rollback failed');
    failEveryRollback(rollbackRefusal);
    expect(() => inTransaction(db, 'sp', () => { db.exec("INSERT INTO probe VALUES ('lost')"); throw new Error('work failed'); })).toThrow('work failed');
    vi.restoreAllMocks();

    inTransaction(db, 'sp', () => db.exec("INSERT INTO probe VALUES ('kept')"));

    expect(db.isTransaction).toBe(false);
    expect(labels()).toEqual(['kept']);
  });

  it('refuses the next call loudly, without running its work, while the stuck transaction cannot be rolled back', () => {
    failEveryRollback(new Error('rollback failed'));
    expect(() => inTransaction(db, 'sp', () => { throw new Error('work failed'); })).toThrow('work failed');
    const work = vi.fn();

    const run = () => inTransaction(db, 'sp', work);

    expect(run).toThrow(/stuck in a transaction/);
    expect(work).not.toHaveBeenCalled();
  });
});
