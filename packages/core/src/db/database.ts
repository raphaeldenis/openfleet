import { chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { backUpBeforeMigrating } from './backup.js';
import { applyMigrations, highestAppliedMigration, pendingMigrations } from './migrate.js';

export class DatabaseOpenError extends Error {
  readonly code = 'DATABASE_OPEN_FAILED';
  constructor(readonly path: string, cause: unknown) {
    super(`cannot open the database at ${path}: ${(cause as Error).message}`);
  }
}

function openFile(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path);
  } catch (error) {
    throw new DatabaseOpenError(path, error);
  }
}

// A migration without a backup is the data-loss case, so a failed backup stops the boot; a database
// that never applied a migration holds nothing worth saving.
function backUpWhenMigrationsArePending(db: DatabaseSync, path: string): void {
  const schemaVersion = highestAppliedMigration(db);
  const holdsAppliedMigrations = schemaVersion !== undefined;
  const hasPendingMigrations = pendingMigrations(db).length > 0;
  if (path === ':memory:' || !holdsAppliedMigrations || !hasPendingMigrations) return;
  try {
    const backupPath = backUpBeforeMigrating(db, { home: dirname(path), schemaVersion });
    log('info', `database backed up to ${backupPath} before migrating`);
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = openFile(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  backUpWhenMigrationsArePending(db, path);
  applyMigrations(db);
  // The db holds session tokens and message bodies in clear text (MAJ-02); WAL mode already created the
  // -wal/-shm side files by now, so tighten all three every time a real (non-:memory:) path is opened.
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  return db;
}
