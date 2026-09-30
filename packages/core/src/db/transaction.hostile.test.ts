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

const labelsOf = (connection: DatabaseSync) =>
  (connection.prepare('SELECT label FROM probe ORDER BY label').all() as { label: string }[]).map((row) => row.label);
const insert = (connection: DatabaseSync, label: string) => connection.exec(`INSERT INTO probe VALUES ('${label}')`);

/** Makes `failingSql` throw before it reaches sqlite; every other statement runs for real. */
function failStatement(connection: DatabaseSync, failingSql: string | RegExp, error = new Error(`${failingSql} refused`)) {
  const realExec = connection.exec.bind(connection);
  return vi.spyOn(connection, 'exec').mockImplementation((sql: string) => {
    const matches = typeof failingSql === 'string' ? sql === failingSql : failingSql.test(sql);
    if (matches) throw error;
    return realExec(sql);
  });
}

describe('inTransaction hostile probes', () => {
  it('surfaces the COMMIT error, rolls back, and leaves the connection usable', () => {
    const commitError = new Error('commit refused');
    failStatement(db, 'COMMIT', commitError);

    const run = () => inTransaction(db, 'sp', () => insert(db, 'lost'));

    expect(run).toThrow(commitError);
    vi.restoreAllMocks();
    expect(db.isTransaction).toBe(false);
    inTransaction(db, 'sp', () => insert(db, 'kept'));
    expect(labelsOf(db)).toEqual(['kept']);
  });

  it('recovers on the next call after COMMIT and ROLLBACK both fail', () => {
    const commitError = new Error('commit refused');
    failStatement(db, /^(COMMIT|ROLLBACK)$/, commitError);
    expect(() => inTransaction(db, 'sp', () => insert(db, 'lost'))).toThrow(commitError);
    expect(db.isTransaction).toBe(true);
    vi.restoreAllMocks();

    inTransaction(db, 'sp', () => insert(db, 'kept'));

    expect(db.isTransaction).toBe(false);
    expect(labelsOf(db)).toEqual(['kept']);
  });

  it('clears the stuck flag once recovered: a later ordinary failure rolls back normally', () => {
    failStatement(db, 'ROLLBACK');
    expect(() => inTransaction(db, 'sp', () => { throw new Error('first'); })).toThrow('first');
    vi.restoreAllMocks();
    inTransaction(db, 'sp', () => insert(db, 'kept'));

    const run = () => inTransaction(db, 'sp', () => { insert(db, 'lost'); throw new Error('second'); });

    expect(run).toThrow('second');
    expect(db.isTransaction).toBe(false);
    expect(labelsOf(db)).toEqual(['kept']);
  });

  it('never rolls back a caller-owned outer transaction after the stuck state was recovered', () => {
    failStatement(db, 'ROLLBACK');
    expect(() => inTransaction(db, 'sp', () => { throw new Error('first'); })).toThrow('first');
    vi.restoreAllMocks();
    inTransaction(db, 'sp', () => insert(db, 'recovered'));
    db.exec('BEGIN IMMEDIATE');
    insert(db, 'outer');

    inTransaction(db, 'inner', () => insert(db, 'inner'));

    expect(db.isTransaction).toBe(true);
    db.exec('COMMIT');
    expect(labelsOf(db)).toEqual(['inner', 'outer', 'recovered']);
  });

  it('treats a ROLLBACK that ended the transaction and then threw as already recovered', () => {
    const realExec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      realExec(sql);
      if (sql === 'ROLLBACK') throw new Error('late failure');
    });
    expect(() => inTransaction(db, 'sp', () => { throw new Error('first'); })).toThrow('first');
    expect(db.isTransaction).toBe(false);
    vi.restoreAllMocks();

    inTransaction(db, 'sp', () => insert(db, 'kept'));

    expect(labelsOf(db)).toEqual(['kept']);
  });

  it('keeps the other connection usable while one is stuck', () => {
    const other = openDatabase(':memory:');
    other.exec('CREATE TABLE probe (label TEXT)');
    failStatement(db, 'ROLLBACK');
    expect(() => inTransaction(db, 'sp', () => { throw new Error('first'); })).toThrow('first');

    inTransaction(other, 'sp', () => insert(other, 'fine'));

    expect(labelsOf(other)).toEqual(['fine']);
    expect(() => inTransaction(db, 'sp', () => undefined)).toThrow(/stuck in a transaction/);
  });

  it('keeps the original error when a nested ROLLBACK TO fails, then rolls the untrustworthy outer transaction back at the next boundary', () => {
    const original = new Error('inner failed');
    db.exec('BEGIN IMMEDIATE');
    insert(db, 'outer');
    failStatement(db, /^ROLLBACK TO/);

    const run = () => inTransaction(db, 'inner', () => { insert(db, 'inner'); throw original; });

    expect(run).toThrow(original);
    vi.restoreAllMocks();
    expect(db.isTransaction).toBe(true);

    inTransaction(db, 'again', () => insert(db, 'again'));

    expect(db.isTransaction).toBe(false);
    expect(labelsOf(db)).toEqual(['again']);
  });

  it('never rolls back a fresh caller-owned transaction opened after the stuck one was ended outside inTransaction', () => {
    failStatement(db, 'ROLLBACK');
    expect(() => inTransaction(db, 'sp', () => { throw new Error('first'); })).toThrow('first');
    vi.restoreAllMocks();
    db.exec('ROLLBACK');
    db.exec('BEGIN IMMEDIATE');
    insert(db, 'outer');

    inTransaction(db, 'inner', () => insert(db, 'inner'));

    expect(db.isTransaction).toBe(true);
    db.exec('COMMIT');
  });

  it('does not attempt or log a rollback when the work already ended the transaction', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = () => inTransaction(db, 'sp', () => { db.exec('ROLLBACK'); throw new Error('work failed'); });

    expect(run).toThrow('work failed');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('pops the savepoint of a failed nested call off the stack', () => {
    db.exec('BEGIN IMMEDIATE');
    expect(() => inTransaction(db, 'inner', () => { throw new Error('inner failed'); })).toThrow('inner failed');

    const releaseLeakedSavepoint = () => db.exec('RELEASE inner');

    expect(releaseLeakedSavepoint).toThrow(/no such savepoint/);
    db.exec('ROLLBACK');
  });

  it('keeps the original error when a nested RELEASE after ROLLBACK TO fails', () => {
    const original = new Error('inner failed');
    db.exec('BEGIN IMMEDIATE');
    failStatement(db, /^RELEASE/);

    const run = () => inTransaction(db, 'inner', () => { throw original; });

    expect(run).toThrow(original);
    vi.restoreAllMocks();
    db.exec('ROLLBACK');
    expect(db.isTransaction).toBe(false);
  });

  it('surfaces the RELEASE error of a nested success path and undoes the nested work', () => {
    const releaseError = new Error('release refused');
    db.exec('BEGIN IMMEDIATE');
    failStatement(db, /^RELEASE/, releaseError);

    const run = () => inTransaction(db, 'inner', () => insert(db, 'inner'));

    expect(run).toThrow(releaseError);
    vi.restoreAllMocks();
    db.exec('COMMIT');
    expect(labelsOf(db)).toEqual([]);
  });

  it.each([['a string', 'boom'], ['undefined', undefined], ['a number', 42]])('rethrows %s thrown by the work and rolls back', (_label, thrown) => {
    let caught: unknown = 'not thrown';

    try {
      inTransaction(db, 'sp', () => { insert(db, 'lost'); throw thrown; });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrown);
    expect(db.isTransaction).toBe(false);
    expect(labelsOf(db)).toEqual([]);
  });

  it('rethrows a non-Error ROLLBACK failure without masking the original error', () => {
    failStatement(db, 'ROLLBACK', 'string rollback failure' as unknown as Error);

    const run = () => inTransaction(db, 'sp', () => { throw new Error('original'); });

    expect(run).toThrow('original');
  });

  it('commits before an async work rejects (documents that async work is not supported)', async () => {
    const promise = inTransaction(db, 'sp', () => { insert(db, 'early'); return Promise.reject(new Error('late')); });

    await expect(promise).rejects.toThrow('late');

    expect(labelsOf(db)).toEqual(['early']);
  });

  it('rolls back a sync throw that follows an unawaited rejection', async () => {
    const run = () => inTransaction(db, 'sp', () => { insert(db, 'lost'); void Promise.resolve(); throw new Error('sync'); });

    expect(run).toThrow('sync');

    expect(labelsOf(db)).toEqual([]);
  });

  it('nests three levels: an inner failure caught by the middle level keeps the middle and outer work', () => {
    inTransaction(db, 'l1', () => {
      insert(db, 'l1');
      inTransaction(db, 'l2', () => {
        insert(db, 'l2');
        try {
          inTransaction(db, 'l3', () => { insert(db, 'l3'); throw new Error('l3 failed'); });
        } catch { /* swallowed by the middle level */ }
      });
    });

    expect(db.isTransaction).toBe(false);
    expect(labelsOf(db)).toEqual(['l1', 'l2']);
  });

  it('nests three levels: a failure at the middle level after a good inner call rolls back the middle and inner work only', () => {
    inTransaction(db, 'l1', () => {
      insert(db, 'l1');
      try {
        inTransaction(db, 'l2', () => {
          insert(db, 'l2');
          inTransaction(db, 'l3', () => insert(db, 'l3'));
          throw new Error('l2 failed');
        });
      } catch { /* swallowed by the outer level */ }
    });

    expect(labelsOf(db)).toEqual(['l1']);
  });

  it('nests reusing the same savepoint name', () => {
    inTransaction(db, 'same', () => {
      insert(db, 'a');
      try {
        inTransaction(db, 'same', () => { insert(db, 'b'); throw new Error('inner'); });
      } catch { /* swallowed */ }
    });

    expect(labelsOf(db)).toEqual(['a']);
    expect(db.isTransaction).toBe(false);
  });

  it('a stuck top-level transaction refuses a nested call too, before opening any savepoint', () => {
    failStatement(db, 'ROLLBACK');
    expect(() => inTransaction(db, 'sp', () => { throw new Error('first'); })).toThrow('first');
    const work = vi.fn();

    const run = () => inTransaction(db, 'other', work);

    expect(run).toThrow(/stuck in a transaction/);
    expect(work).not.toHaveBeenCalled();
  });
});
