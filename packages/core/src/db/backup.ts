import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BACKUPS_FOLDER_NAME } from './migrate.js';

const BACKUPS_TO_KEEP = 3;
const BACKUP_NAME_PATTERN = /^openfleet-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.db$/;
const IN_PROGRESS_SUFFIX = '.partial';

export class BackupFailedError extends Error {
  readonly code = 'BACKUP_FAILED';
  constructor(backupsFolder: string, cause: unknown) {
    super(`cannot back up the database to ${backupsFolder} before migrating (${(cause as Error).message}); refusing to migrate without a backup`);
  }
}

const sqlStringLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ponytail: best-effort by design (concurrent daemon, unremovable entry); log it if it ever needs diagnosing
  }
}

function collisionCounterOf(backupName: string): number {
  return Number(BACKUP_NAME_PATTERN.exec(backupName)?.[2] ?? 1);
}

function chronologicalKeyOf(backupName: string): string | undefined {
  const match = BACKUP_NAME_PATTERN.exec(backupName);
  if (match === null) return undefined;
  return `${match[1]}-${String(collisionCounterOf(backupName)).padStart(6, '0')}`;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function backupNamesIn(backupsFolder: string): string[] {
  return readdirSync(backupsFolder).filter((name) => chronologicalKeyOf(name) !== undefined && isRegularFile(join(backupsFolder, name)));
}

// The counter starts above every counter already used in this millisecond, so a freed low counter never
// gives the newest backup the oldest key. The exclusive create on the in-progress name keeps two
// daemons booting in the same millisecond on different names.
function reserveBackupPath(backupsFolder: string, schemaVersion: string): { backupPath: string; inProgressPath: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const highestCounterInThisMillisecond = Math.max(0, ...backupNamesIn(backupsFolder).filter((name) => name.includes(`-${timestamp}`)).map(collisionCounterOf));
  for (let collisionCounter = highestCounterInThisMillisecond + 1; ; collisionCounter++) {
    const suffix = collisionCounter === 1 ? '' : `-${collisionCounter}`;
    const backupPath = join(backupsFolder, `openfleet-${schemaVersion}-${timestamp}${suffix}.db`);
    const inProgressPath = `${backupPath}${IN_PROGRESS_SUFFIX}`;
    if (existsSync(backupPath)) continue;
    try {
      closeSync(openSync(inProgressPath, 'wx', 0o600));
      return { backupPath, inProgressPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

// Runs once the migrations succeeded: a failed or refused boot keeps every snapshot it has.
export function deleteBackupsBeyondTheMostRecent(backupsFolder: string, justTakenPath: string): void {
  try {
    const backupNamesOldestFirst = backupNamesIn(backupsFolder).sort((a, b) => chronologicalKeyOf(a)!.localeCompare(chronologicalKeyOf(b)!));
    for (const name of backupNamesOldestFirst.slice(0, -BACKUPS_TO_KEEP)) {
      const path = join(backupsFolder, name);
      if (path === justTakenPath) continue;
      removeIfPresent(path);
      removeIfPresent(path.replace(/\.db$/, '.config.json'));
    }
  } catch {
    // ponytail: a pruning failure never undoes or fails the backup that was just taken
  }
}

// ponytail: node:sqlite's backup() is async and openDatabase is sync, so VACUUM INTO (one consistent
// read snapshot, WAL included) does the copy into a .partial name that is renamed once complete, so a
// crash leaves no file under a backup name. Stale .partial files are ignored, never pruned: add a
// sweep by age if they ever pile up.
export function backUpBeforeMigrating(db: DatabaseSync, options: { home: string; schemaVersion: string }): string {
  const backupsFolder = join(options.home, BACKUPS_FOLDER_NAME);
  let reservation: ReturnType<typeof reserveBackupPath> | undefined;
  try {
    mkdirSync(backupsFolder, { recursive: true, mode: 0o700 });
    chmodSync(backupsFolder, 0o700);
    reservation = reserveBackupPath(backupsFolder, options.schemaVersion);
    db.exec(`VACUUM INTO ${sqlStringLiteral(reservation.inProgressPath)}`);
    renameSync(reservation.inProgressPath, reservation.backupPath);
    copyConfigAlongside(join(options.home, 'config.json'), reservation.backupPath);
    return reservation.backupPath;
  } catch (error) {
    if (reservation !== undefined) {
      removeIfPresent(reservation.inProgressPath);
      removeIfPresent(reservation.backupPath);
    }
    throw new BackupFailedError(backupsFolder, error);
  }
}

function copyConfigAlongside(configPath: string, backupPath: string): void {
  const configCopyPath = backupPath.replace(/\.db$/, '.config.json');
  try {
    copyFileSync(configPath, configCopyPath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  chmodSync(configCopyPath, 0o600);
}
