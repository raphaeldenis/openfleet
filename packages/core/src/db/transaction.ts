import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';

export class StuckConnectionError extends Error {
  constructor(cause: unknown) {
    super('database connection is stuck in a transaction after a failed ROLLBACK', { cause });
  }
}

/** Connections left inside a transaction by a failed top-level ROLLBACK: nothing may run on them until a ROLLBACK succeeds. */
const connectionsStuckInTransaction = new WeakSet<DatabaseSync>();

/**
 * Runs `work` atomically: a transaction of its own (BEGIN IMMEDIATE/COMMIT), or a SAVEPOINT/RELEASE
 * nested inside a caller's transaction, so a batch is all-or-nothing without ending an outer transaction.
 * Rolls back only if a transaction is still active. A failing rollback is logged and never masks the
 * original error; a failed top-level ROLLBACK marks the connection stuck, and every later call retries the
 * ROLLBACK first and throws, without running its work, while that keeps failing.
 * A failed nested rollback leaves the outer transaction to its owner.
 * All production code goes through `inTransaction`: a raw BEGIN outside it is a bug.
 * `name` must be distinct per call site so nested savepoints never collide.
 */
export function inTransaction<T>(db: DatabaseSync, name: string, work: () => T): T {
  recoverStuckTransaction(db);
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

/** Retries the ROLLBACK of a stuck connection; throws while it still fails. Does nothing on a healthy connection. */
export function recoverStuckTransaction(db: DatabaseSync): void {
  if (!connectionsStuckInTransaction.has(db)) return;
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch (rollbackError) {
    log('error', 'refusing to run: connection is stuck in a transaction', rollbackError);
    throw new StuckConnectionError(rollbackError);
  }
  connectionsStuckInTransaction.delete(db);
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
