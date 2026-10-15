import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { afterCommit, inTransaction } from './transaction.js';

let db: DatabaseSync;
let ran: string[];

beforeEach(() => {
  db = openDatabase(':memory:');
  ran = [];
});

const announce = (label: string) => () => { ran.push(label); };

describe('afterCommit', () => {
  it('runs the action at once when no transaction is open', () => {
    afterCommit(db, announce('immediate'));

    expect(ran).toEqual(['immediate']);
  });

  it('runs the action after the transaction commits, never before, outside the transaction', () => {
    const insideTransactionWhenRun: boolean[] = [];

    inTransaction(db, 'outer', () => {
      afterCommit(db, () => insideTransactionWhenRun.push(db.isTransaction));
      expect(insideTransactionWhenRun).toEqual([]);
    });

    expect(insideTransactionWhenRun).toEqual([false]);
  });

  it('drops the action of a transaction that rolls back', () => {
    expect(() => inTransaction(db, 'outer', () => {
      afterCommit(db, announce('lost'));
      throw new Error('work failed');
    })).toThrow('work failed');

    expect(ran).toEqual([]);
  });

  it('waits for the outermost commit when savepoints are nested, and keeps the order of registration', () => {
    inTransaction(db, 'outer', () => {
      afterCommit(db, announce('first'));
      inTransaction(db, 'inner', () => { afterCommit(db, announce('second')); });
      expect(ran).toEqual([]);
      afterCommit(db, announce('third'));
    });

    expect(ran).toEqual(['first', 'second', 'third']);
  });

  it('drops only the actions of a savepoint that rolls back', () => {
    inTransaction(db, 'outer', () => {
      afterCommit(db, announce('kept'));
      try {
        inTransaction(db, 'inner', () => {
          afterCommit(db, announce('dropped'));
          throw new Error('inner failed');
        });
      } catch { /* the outer transaction carries on */ }
    });

    expect(ran).toEqual(['kept']);
  });

  it('does not leak the actions of a rolled-back transaction into the next transaction', () => {
    try {
      inTransaction(db, 'first', () => { afterCommit(db, announce('lost')); throw new Error('boom'); });
    } catch { /* expected */ }

    inTransaction(db, 'second', () => { afterCommit(db, announce('own')); });

    expect(ran).toEqual(['own']);
  });

  it('keeps running the other actions, and the commit result, when one action throws', () => {
    const result = inTransaction(db, 'outer', () => {
      afterCommit(db, () => { throw new Error('listener failed'); });
      afterCommit(db, announce('after the failing one'));
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(ran).toEqual(['after the failing one']);
  });
});
