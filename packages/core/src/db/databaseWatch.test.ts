import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { inTransaction, setDatabaseWatch, type DatabaseWatch } from './transaction.js';

const unavailableError = () => Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR', errcode: 14 });

/** A connection whose statements fail with `failWith` while it is set; everything else is the real in-memory database. */
function failableDatabase() {
  const real = openDatabase(':memory:');
  const control: { failWith?: Error } = {};
  const db = new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'exec') return (sql: string) => { if (control.failWith) throw control.failWith; return target.exec(sql); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseSync;
  real.exec('CREATE TABLE t (a)');
  return { db, control };
}

describe('the database watch of inTransaction', () => {
  let watch: { unavailable: ReturnType<typeof vi.fn>; writeSucceeded: ReturnType<typeof vi.fn> };
  let unwatch: () => void;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    watch = { unavailable: vi.fn(), writeSucceeded: vi.fn() };
    unwatch = setDatabaseWatch(watch as DatabaseWatch);
  });
  afterEach(() => {
    unwatch();
    vi.restoreAllMocks();
  });

  it('reports a write that commits', () => {
    const { db } = failableDatabase();

    inTransaction(db, 'a', () => db.exec('INSERT INTO t VALUES (1)'));

    expect(watch.writeSucceeded).toHaveBeenCalledTimes(1);
    expect(watch.unavailable).not.toHaveBeenCalled();
  });

  it('reports an unavailable database once, when the transaction cannot begin, and still throws the original error', () => {
    const { db, control } = failableDatabase();
    control.failWith = unavailableError();

    expect(() => inTransaction(db, 'a', () => 1)).toThrow(control.failWith);

    expect(watch.unavailable).toHaveBeenCalledExactlyOnceWith(control.failWith);
    expect(watch.writeSucceeded).not.toHaveBeenCalled();
  });

  it('reports an unavailable database that the work itself meets', () => {
    const { db } = failableDatabase();
    const failure = unavailableError();

    expect(() => inTransaction(db, 'a', () => { throw failure; })).toThrow(failure);

    expect(watch.unavailable).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('reports the error once when a nested transaction and its outer one both see it', () => {
    const { db } = failableDatabase();
    const failure = unavailableError();

    expect(() => inTransaction(db, 'outer', () => inTransaction(db, 'inner', () => { throw failure; }))).toThrow(failure);

    expect(watch.unavailable).toHaveBeenCalledTimes(1);
  });

  it('does not report an error that says nothing about the database being unavailable', () => {
    const { db } = failableDatabase();

    expect(() => inTransaction(db, 'a', () => { throw new Error('a bug in the work'); })).toThrow('a bug in the work');

    expect(watch.unavailable).not.toHaveBeenCalled();
    expect(watch.writeSucceeded).not.toHaveBeenCalled();
  });

  it('does not call a nested release a successful write: only a top-level commit proves the db takes writes', () => {
    const { db } = failableDatabase();

    inTransaction(db, 'outer', () => { inTransaction(db, 'inner', () => 1); expect(watch.writeSucceeded).not.toHaveBeenCalled(); });

    expect(watch.writeSucceeded).toHaveBeenCalledTimes(1);
  });

  it('reports a connection stuck after a failed ROLLBACK', () => {
    const { db, control } = failableDatabase();
    const rollbackFailure = unavailableError();
    // The work fails, and so does the ROLLBACK that follows it: the connection is left stuck in its transaction.
    expect(() => inTransaction(db, 'a', () => { control.failWith = rollbackFailure; throw new Error('work failed'); })).toThrow('work failed');

    expect(() => inTransaction(db, 'b', () => 1)).toThrow(/stuck/);

    expect(watch.unavailable).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('stuck') }));
  });

  it('keeps working without any watch', () => {
    unwatch();
    const { db } = failableDatabase();

    expect(inTransaction(db, 'a', () => 7)).toBe(7);
  });

  it('stops an older watcher from unwatching a newer one', () => {
    const newer = { unavailable: vi.fn(), writeSucceeded: vi.fn() };
    const unwatchNewer = setDatabaseWatch(newer as DatabaseWatch);
    unwatch();
    const { db } = failableDatabase();

    inTransaction(db, 'a', () => 1);

    expect(newer.writeSucceeded).toHaveBeenCalledTimes(1);
    unwatchNewer();
  });
});
