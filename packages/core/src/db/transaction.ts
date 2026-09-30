import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';

const STUCK_TRANSACTION_MARKER = 'openfleet_stuck_transaction_marker';

/**
 * Connections whose transaction cannot be trusted after a failed ROLLBACK (top-level) or ROLLBACK TO (nested):
 * nothing may nest into it. The value tells whether a marker savepoint was planted in that transaction,
 * so a later fresh transaction of a caller is told apart from the stuck one.
 */
const connectionsStuckInTransaction = new WeakMap<DatabaseSync, { hasMarker: boolean }>();

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
    markStuckInTransaction(db);
  }
}

function markStuckInTransaction(db: DatabaseSync): void {
  const hasMarker = plantMarkerSavepoint(db);
  connectionsStuckInTransaction.set(db, { hasMarker });
}

function plantMarkerSavepoint(db: DatabaseSync): boolean {
  if (!db.isTransaction) return false;
  try {
    db.exec(`SAVEPOINT ${STUCK_TRANSACTION_MARKER}`);
    return true;
  } catch {
    return false;
  }
}

/** True while the transaction that got stuck is still the connection's current one. */
function isStuckTransactionStillOpen(db: DatabaseSync, { hasMarker }: { hasMarker: boolean }): boolean {
  if (!db.isTransaction) return false;
  if (!hasMarker) return true;
  try {
    db.exec(`ROLLBACK TO ${STUCK_TRANSACTION_MARKER}`);
    return true;
  } catch {
    return false;
  }
}

function releaseStuckTransaction(db: DatabaseSync): void {
  const stuck = connectionsStuckInTransaction.get(db);
  if (!stuck) return;
  if (isStuckTransactionStillOpen(db, stuck)) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new Error('database connection is stuck in a transaction after a failed ROLLBACK', { cause: rollbackError });
    }
  }
  connectionsStuckInTransaction.delete(db);
}
