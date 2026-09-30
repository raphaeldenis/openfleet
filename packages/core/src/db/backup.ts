import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BACKUPS_FOLDER_NAME } from './migrate.js';

const BACKUPS_TO_KEEP = 3;
const BACKUP_NAME_PATTERN = /^openfleet-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.db$/;

export class BackupFailedError extends Error {
  readonly code = 'BACKUP_FAILED';
  constructor(backupsFolder: string, cause: unknown) {
    super(`cannot back up the database to ${backupsFolder} before migrating (${(cause as Error).message}); refusing to migrate without a backup`);
  }
}

const sqlStringLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`;

function chronologicalKeyOf(backupName: string): string | undefined {
  const match = BACKUP_NAME_PATTERN.exec(backupName);
  if (match === null) return undefined;
  const collisionCounter = String(match[2] ?? 1).padStart(6, '0');
  return `${match[1]}-${collisionCounter}`;
}

// Reserving the name with an exclusive create makes two daemons booting in the same millisecond pick
// different names instead of one overwriting the other.
function reserveBackupPath(backupsFolder: string, schemaVersion: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let collisionCounter = 1; ; collisionCounter++) {
    const suffix = collisionCounter === 1 ? '' : `-${collisionCounter}`;
    const path = join(backupsFolder, `openfleet-${schemaVersion}-${timestamp}${suffix}.db`);
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function deleteBackupsBeyondTheMostRecent(backupsFolder: string): void {
  const backupNamesOldestFirst = readdirSync(backupsFolder)
    .filter((name) => chronologicalKeyOf(name) !== undefined)
    .sort((a, b) => chronologicalKeyOf(a)!.localeCompare(chronologicalKeyOf(b)!));
  for (const name of backupNamesOldestFirst.slice(0, -BACKUPS_TO_KEEP)) {
    unlinkSync(join(backupsFolder, name));
    const configCopy = join(backupsFolder, name.replace(/\.db$/, '.config.json'));
    if (existsSync(configCopy)) unlinkSync(configCopy);
  }
}

// ponytail: node:sqlite's backup() is async and openDatabase is sync, so VACUUM INTO (one consistent
// read snapshot, WAL included) does the copy. A crash mid-copy leaves a truncated file that counts
// as a backup until pruned; add copy-then-rename if that ever bites.
export function backUpBeforeMigrating(db: DatabaseSync, options: { home: string; schemaVersion: string }): string {
  const backupsFolder = join(options.home, BACKUPS_FOLDER_NAME);
  let backupPath: string | undefined;
  try {
    mkdirSync(backupsFolder, { recursive: true, mode: 0o700 });
    chmodSync(backupsFolder, 0o700);
    backupPath = reserveBackupPath(backupsFolder, options.schemaVersion);
    db.exec(`VACUUM INTO ${sqlStringLiteral(backupPath)}`);
    copyConfigAlongside(join(options.home, 'config.json'), backupPath);
    deleteBackupsBeyondTheMostRecent(backupsFolder);
    return backupPath;
  } catch (error) {
    if (backupPath !== undefined && existsSync(backupPath)) unlinkSync(backupPath);
    throw new BackupFailedError(backupsFolder, error);
  }
}

function copyConfigAlongside(configPath: string, backupPath: string): void {
  if (!existsSync(configPath)) return;
  const configCopyPath = backupPath.replace(/\.db$/, '.config.json');
  copyFileSync(configPath, configCopyPath);
  chmodSync(configCopyPath, 0o600);
}
