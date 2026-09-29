import type { DatabaseSync } from 'node:sqlite';

/**
 * Runs `work` atomically: a transaction of its own (BEGIN IMMEDIATE/COMMIT), or a SAVEPOINT/RELEASE
 * nested inside a caller's transaction, so a batch is all-or-nothing without ending an outer transaction.
 * Rolls back only if a transaction is still active, so the original error is never masked by a rollback
 * failure. `name` must be distinct per call site so nested savepoints never collide.
 */
export function inTransaction<T>(db: DatabaseSync, name: string, work: () => T): T {
  const isNested = db.isTransaction;
  db.exec(isNested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(isNested ? `RELEASE ${name}` : 'COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      if (isNested) {
        // ROLLBACK TO alone leaves the savepoint marker open on the stack; RELEASE pops it, the safe idiom.
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } else {
        db.exec('ROLLBACK');
      }
    }
    throw error;
  }
}
