import { chmodSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { backUpBeforeMigrating, clearPreUpgradeMarker, preUpgradeSnapshotName, pruneBackupsKeepingRecentSchemaVersions, recordPreUpgradeSnapshot } from './backup.js';
import { applyMigrations, assertBootableSchema, highestAppliedMigration, MigrationFailedError, pendingMigrations, shippedMigrationVersions } from './migrate.js';

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
function backUpWhenMigrationsArePending(db: DatabaseSync, path: string): string | undefined {
  const schemaVersion = highestAppliedMigration(db);
  const holdsAppliedMigrations = schemaVersion !== undefined;
  const hasPendingMigrations = pendingMigrations(db).length > 0;
  if (path === ':memory:' || !holdsAppliedMigrations || !hasPendingMigrations) return undefined;
  try {
    assertBootableSchema(db, path);
    const backupPath = backUpBeforeMigrating(db, { home: dirname(path), schemaVersion });
    log('info', `database backed up to ${backupPath} before migrating`);
    recordPreUpgradeSnapshot(dirname(backupPath), basename(backupPath), shippedMigrationVersions());
    pruneBackupsKeepingRecentSchemaVersions(dirname(backupPath), backupPath, shippedMigrationVersions());
    return backupPath;
  } catch (error) {
    db.close();
    throw error;
  }
}

// The backup just taken holds a schema that may already include migrations an earlier failed boot
// committed; the marker names the snapshot taken before the first attempt of this upgrade.
function snapshotFromBeforeTheUpgrade(backupPath: string): string {
  const backupsFolder = dirname(backupPath);
  const markedName = preUpgradeSnapshotName(backupsFolder, shippedMigrationVersions());
  return markedName === undefined ? backupPath : join(backupsFolder, markedName);
}

function endTheUpgrade(backupPath: string | undefined): void {
  if (backupPath === undefined) return;
  clearPreUpgradeMarker(dirname(backupPath));
  pruneBackupsKeepingRecentSchemaVersions(dirname(backupPath), backupPath, shippedMigrationVersions());
}

function migrateNamingTheBackupOnFailure(db: DatabaseSync, path: string, backupPath: string | undefined): void {
  try {
    applyMigrations(db, undefined, path);
  } catch (error) {
    db.close();
    throw backupPath === undefined ? error : new MigrationFailedError(error, snapshotFromBeforeTheUpgrade(backupPath));
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = openFile(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  const backupPath = backUpWhenMigrationsArePending(db, path);
  migrateNamingTheBackupOnFailure(db, path, backupPath);
  endTheUpgrade(backupPath);
  // The db holds session tokens and message bodies in clear text (MAJ-02); WAL mode already created the
  // -wal/-shm side files by now, so tighten all three every time a real (non-:memory:) path is opened.
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  return db;
}
