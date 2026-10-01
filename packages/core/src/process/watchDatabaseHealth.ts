import { setDatabaseWatch } from '../db/transaction.js';
import type { DegradedRegistry } from './degradedRegistry.js';

const DATABASE_UNAVAILABLE_MESSAGE = 'the database is not accepting writes.';

/** Marks `db_stuck` while a transaction cannot begin or commit for want of the database, and clears it on the next commit. Returns the function that stops watching. */
export function watchDatabaseHealth(degraded: DegradedRegistry): () => void {
  return setDatabaseWatch({
    unavailable: (error) => degraded.mark('db_stuck', DATABASE_UNAVAILABLE_MESSAGE, { cause: error }),
    writeSucceeded: () => degraded.clear('db_stuck'),
  });
}
