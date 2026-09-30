import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';

/** Connections whose top-level ROLLBACK failed: the transaction may still be open, so nothing may nest into it. */
const connectionsStuckInTransaction = new WeakSet<DatabaseSync>();

/**
 * Runs `work` atomically: a transaction of its own (BEGIN IMMEDIATE/COMMIT), or a SAVEPOINT/RELEASE
 * nested inside a caller's transaction, so a batch is all-or-nothing without ending an outer transaction.
 * Rolls back only if a transaction is still active. A failing rollback is logged and never masks the
 * original error; a connection left inside a transaction by a failed top-level ROLLBACK is rolled back
 * again by the next call, which throws instead of silently nesting into it when that fails too.
 * `name` must be distinct per call site so nested savepoints never collide.
 */
export function inTransaction<T>(db: DatabaseSync, name: string, work: () => T): T {
  releaseStuckTransaction(db);
  const isNested = db.isTransaction;
  db.exec(isNested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(isNested ? `RELEASE ${name}` : 'COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) rollBackKeepingOriginalError(db, { name, isNested });
    throw error;
  }
}

function rollBackKeepingOriginalError(db: DatabaseSync, { name, isNested }: { name: string; isNested: boolean }): void {
  try {
    if (isNested) {
      // ROLLBACK TO alone leaves the savepoint marker open on the stack; RELEASE pops it, the safe idiom.
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } else {
      db.exec('ROLLBACK');
    }
  } catch (rollbackError) {
    log('error', 'transaction rollback failed', rollbackError);
    if (!isNested) connectionsStuckInTransaction.add(db);
  }
}

function releaseStuckTransaction(db: DatabaseSync): void {
  if (!connectionsStuckInTransaction.has(db)) return;
  if (db.isTransaction) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new Error('database connection is stuck in a transaction after a failed ROLLBACK', { cause: rollbackError });
    }
  }
  connectionsStuckInTransaction.delete(db);
}
