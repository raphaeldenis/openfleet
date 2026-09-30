import { chmodSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { BACKUPS_FOLDER_NAME, backUpBeforeMigrating, clearPreUpgradeMarker, pruneBackupsKeepingRecentSchemaVersions, recordPreUpgradeSnapshot } from './backup.js';
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
interface UpgradeBackup {
  backupsFolder: string;
  /** The snapshot this boot just took. It may already include migrations an earlier failed boot committed. */
  backupPath: string;
  /** The snapshot the upgrade started from: the marked one while migrations committed since it, else this boot's. */
  preUpgradeSnapshotName: string;
}

function backUpWhenMigrationsArePending(db: DatabaseSync, path: string): UpgradeBackup | undefined {
  const schemaVersion = highestAppliedMigration(db);
  const holdsAppliedMigrations = schemaVersion !== undefined;
  const hasPendingMigrations = pendingMigrations(db).length > 0;
  if (path === ':memory:' || !holdsAppliedMigrations || !hasPendingMigrations) return undefined;
  try {
    assertBootableSchema(db, path);
    const backupPath = backUpBeforeMigrating(db, { home: dirname(path), schemaVersion });
    log('info', `database backed up to ${backupPath} before migrating`);
    const backupsFolder = dirname(backupPath);
    const knownVersions = shippedMigrationVersions();
    const preUpgradeSnapshotName = recordPreUpgradeSnapshot(backupsFolder, basename(backupPath), knownVersions, schemaVersion);
    pruneBackupsKeepingRecentSchemaVersions(backupsFolder, { justTakenPath: backupPath, preUpgradeSnapshotName, knownVersions });
    return { backupsFolder, backupPath, preUpgradeSnapshotName };
  } catch (error) {
    db.close();
    throw error;
  }
}

// A boot with nothing to migrate means no upgrade is in flight, so a marker left by a crash between the
// last migration and its clearing goes too. The snapshot the upgrade started from survives the first
// pruning after a success, so a user can still roll back to it.
function endTheUpgrade(path: string, upgradeBackup: UpgradeBackup | undefined): void {
  if (path === ':memory:') return;
  if (upgradeBackup === undefined) {
    clearPreUpgradeMarker(join(dirname(path), BACKUPS_FOLDER_NAME));
    return;
  }
  clearPreUpgradeMarker(upgradeBackup.backupsFolder);
  pruneBackupsKeepingRecentSchemaVersions(upgradeBackup.backupsFolder, { justTakenPath: upgradeBackup.backupPath, preUpgradeSnapshotName: upgradeBackup.preUpgradeSnapshotName, knownVersions: shippedMigrationVersions() });
}

function migrateNamingTheBackupOnFailure(db: DatabaseSync, path: string, upgradeBackup: UpgradeBackup | undefined): void {
  try {
    applyMigrations(db, undefined, path);
  } catch (error) {
    db.close();
    throw upgradeBackup === undefined ? error : new MigrationFailedError(error, join(upgradeBackup.backupsFolder, upgradeBackup.preUpgradeSnapshotName));
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = openFile(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  const upgradeBackup = backUpWhenMigrationsArePending(db, path);
  migrateNamingTheBackupOnFailure(db, path, upgradeBackup);
  endTheUpgrade(path, upgradeBackup);
  // The db holds session tokens and message bodies in clear text (MAJ-02); WAL mode already created the
  // -wal/-shm side files by now, so tighten all three every time a real (non-:memory:) path is opened.
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  return db;
}
