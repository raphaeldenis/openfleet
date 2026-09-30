import { chmodSync, closeSync, existsSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';

export const BACKUPS_FOLDER_NAME = 'backups';
const SCHEMA_VERSIONS_TO_KEEP = 3;
const BACKUP_NAME_PATTERN = /^openfleet-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.db$/;
const CONFIG_COPY_NAME_PATTERN = /^(openfleet-.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?)\.config\.json$/;
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
  return Number(BACKUP_NAME_PATTERN.exec(backupName)?.[3] ?? 1);
}

function schemaVersionOf(backupName: string): string {
  return BACKUP_NAME_PATTERN.exec(backupName)![1]!;
}

function chronologicalKeyOf(backupName: string): string | undefined {
  const match = BACKUP_NAME_PATTERN.exec(backupName);
  if (match === null) return undefined;
  return `${match[2]}-${String(collisionCounterOf(backupName)).padStart(6, '0')}`;
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

// Retention deliberately departs from "the 3 most recent backups": it keeps the newest backup of each of
// the 3 most recent schema versions (the version in the file name, ordered by migration name). Neither
// clock nor file date decides which versions survive, so a clock rollback cannot evict a version and
// the snapshot from before an upgrade outlives any number of failed retries. The clock only picks the
// newest copy inside one schema version, where the backup just taken always counts as the newest.
function newestBackupNameBySchemaVersion(backupsFolder: string, justTakenName?: string): Map<string, string> {
  const newestNameBySchemaVersion = new Map<string, string>();
  for (const name of backupNamesIn(backupsFolder)) {
    const version = schemaVersionOf(name);
    const currentNewest = newestNameBySchemaVersion.get(version);
    const isNewest = currentNewest === undefined || (currentNewest !== justTakenName && (name === justTakenName || chronologicalKeyOf(name)! > chronologicalKeyOf(currentNewest)!));
    if (isNewest) newestNameBySchemaVersion.set(version, name);
  }
  return newestNameBySchemaVersion;
}

function retainedSchemaVersions(newestNameBySchemaVersion: Map<string, string>): string[] {
  return [...newestNameBySchemaVersion.keys()].sort();
}

/** Returns the name of the oldest retained backup whose schema version is older than `schemaVersion`: the one the previous app can open. */
export function oldestBackupNameOlderThan(backupsFolder: string, schemaVersion: string): string | undefined {
  const newestNameBySchemaVersion = newestBackupNameBySchemaVersion(backupsFolder);
  const oldestVersionOlderThanTarget = retainedSchemaVersions(newestNameBySchemaVersion).find((version) => version < schemaVersion);
  return oldestVersionOlderThanTarget === undefined ? undefined : newestNameBySchemaVersion.get(oldestVersionOlderThanTarget);
}

/** Returns the name of the newest retained backup whose schema version is at most `schemaVersion`: the newest one this app can open. */
export function newestBackupNameUpTo(backupsFolder: string, schemaVersion: string): string | undefined {
  const newestNameBySchemaVersion = newestBackupNameBySchemaVersion(backupsFolder);
  const newestVersionTheAppKnows = retainedSchemaVersions(newestNameBySchemaVersion).filter((version) => version <= schemaVersion).pop();
  return newestVersionTheAppKnows === undefined ? undefined : newestNameBySchemaVersion.get(newestVersionTheAppKnows);
}

function removeConfigCopiesWithoutABackup(backupsFolder: string): void {
  const backupStems = new Set(backupNamesIn(backupsFolder).map((name) => name.replace(/\.db$/, '')));
  for (const name of readdirSync(backupsFolder)) {
    const stem = CONFIG_COPY_NAME_PATTERN.exec(name)?.[1];
    const isOrphan = stem !== undefined && !backupStems.has(stem) && isRegularFile(join(backupsFolder, name));
    if (isOrphan) removeIfPresent(join(backupsFolder, name));
  }
}

export function pruneBackupsKeepingRecentSchemaVersions(backupsFolder: string, justTakenPath: string): void {
  try {
    const justTakenName = basename(justTakenPath);
    const newestNameBySchemaVersion = newestBackupNameBySchemaVersion(backupsFolder, justTakenName);
    const keptVersions = retainedSchemaVersions(newestNameBySchemaVersion).slice(-SCHEMA_VERSIONS_TO_KEEP);
    const keptNames = new Set([justTakenName, ...keptVersions.map((version) => newestNameBySchemaVersion.get(version)!)]);
    for (const name of backupNamesIn(backupsFolder)) if (!keptNames.has(name)) removeIfPresent(join(backupsFolder, name));
    removeConfigCopiesWithoutABackup(backupsFolder);
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

function readConfigIfPresent(configPath: string): Buffer | undefined {
  try {
    return readFileSync(configPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

// The copy is created exclusively (never through a symlink), sealed at 0600 through its own descriptor,
// then hard-linked to its final name, which fails rather than replaces anything already there.
function copyConfigAlongside(configPath: string, backupPath: string): void {
  const config = readConfigIfPresent(configPath);
  if (config === undefined) return;
  const configCopyPath = backupPath.replace(/\.db$/, '.config.json');
  const inProgressPath = `${configCopyPath}${IN_PROGRESS_SUFFIX}`;
  let createdInProgressFile = false;
  try {
    const descriptor = openSync(inProgressPath, 'wx', 0o600);
    createdInProgressFile = true;
    try {
      writeFileSync(descriptor, config);
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    linkSync(inProgressPath, configCopyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    log('warn', `config copy skipped: ${configCopyPath} or its temp name is already taken`);
  } finally {
    if (createdInProgressFile) removeIfPresent(inProgressPath);
  }
}
