import { chmodSync, closeSync, existsSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';

export const BACKUPS_FOLDER_NAME = 'backups';
const SCHEMA_VERSIONS_TO_KEEP = 3;
const PRE_UPGRADE_MARKER_NAME = 'pre-upgrade.marker';
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

/**
 * Returns the file name the pre-upgrade marker holds while an upgrade is in flight: it names a backup of a
 * shipped schema version still in the folder, and that version is strictly older than the one the database
 * holds now, so migrations committed since the snapshot.
 */
export function preUpgradeSnapshotName(backupsFolder: string, knownVersions: ReadonlySet<string>, databaseSchemaVersion: string): string | undefined {
  const markerPath = join(backupsFolder, PRE_UPGRADE_MARKER_NAME);
  if (!isRegularFile(markerPath)) return undefined;
  try {
    const markedName = readFileSync(markerPath, 'utf8');
    const isAnExistingBackup = backupNamesIn(backupsFolder).includes(markedName);
    if (!isAnExistingBackup) return undefined;
    const markedVersion = schemaVersionOf(markedName);
    const hasMigrationsCommittedSinceTheSnapshot = markedVersion < databaseSchemaVersion;
    return knownVersions.has(markedVersion) && hasMigrationsCommittedSinceTheSnapshot ? markedName : undefined;
  } catch {
    return undefined;
  }
}

// The marker holds the exact name of the snapshot taken before the first boot of an upgrade. It is
// created through a temp name and renamed into place, so a symlink or stale file under the marker name is
// replaced, never followed; a marker that cannot be written leaves the hint on this boot's snapshot.
// Returns the snapshot the upgrade started from: the marked one while it is still valid, else this boot's.
export function recordPreUpgradeSnapshot(backupsFolder: string, backupName: string, knownVersions: ReadonlySet<string>, databaseSchemaVersion: string): string {
  const markedName = preUpgradeSnapshotName(backupsFolder, knownVersions, databaseSchemaVersion);
  if (markedName !== undefined) return markedName;
  const markerPath = join(backupsFolder, PRE_UPGRADE_MARKER_NAME);
  const inProgressPath = `${markerPath}${IN_PROGRESS_SUFFIX}`;
  removeIfPresent(inProgressPath);
  try {
    writeFileSync(inProgressPath, backupName, { flag: 'wx', mode: 0o600 });
    renameSync(inProgressPath, markerPath);
  } catch (error) {
    removeIfPresent(inProgressPath);
    log('warn', `pre-upgrade marker not written: ${(error as Error).message}`);
  }
  return backupName;
}

export function clearPreUpgradeMarker(backupsFolder: string): void {
  removeIfPresent(join(backupsFolder, PRE_UPGRADE_MARKER_NAME));
}

// Retention deliberately departs from "the 3 most recent backups": it keeps the newest backup of each of
// the 3 most recent schema versions (the version in the file name, ordered by migration name) among the
// versions this app ships, plus the pre-upgrade snapshot. Neither clock nor file date decides which
// versions survive, so a clock rollback cannot evict a version. The clock only picks the newest copy
// inside one schema version, where the backup just taken always counts as the newest.
function newestBackupNameBySchemaVersion(backupsFolder: string, knownVersions: ReadonlySet<string>, justTakenName?: string): Map<string, string> {
  const newestNameBySchemaVersion = new Map<string, string>();
  for (const name of backupNamesIn(backupsFolder)) {
    const version = schemaVersionOf(name);
    if (!knownVersions.has(version)) continue;
    const currentNewest = newestNameBySchemaVersion.get(version);
    const isNewest = currentNewest === undefined || (currentNewest !== justTakenName && (name === justTakenName || chronologicalKeyOf(name)! > chronologicalKeyOf(currentNewest)!));
    if (isNewest) newestNameBySchemaVersion.set(version, name);
  }
  return newestNameBySchemaVersion;
}

function retainedSchemaVersions(newestNameBySchemaVersion: Map<string, string>): string[] {
  return [...newestNameBySchemaVersion.keys()].sort();
}

/** Returns the name of the newest backup whose schema version this app ships: the newest one this app can open. */
export function newestKnownBackupName(backupsFolder: string, knownVersions: ReadonlySet<string>): string | undefined {
  const newestNameBySchemaVersion = newestBackupNameBySchemaVersion(backupsFolder, knownVersions);
  const newestKnownVersion = retainedSchemaVersions(newestNameBySchemaVersion).pop();
  return newestKnownVersion === undefined ? undefined : newestNameBySchemaVersion.get(newestKnownVersion);
}

function removeConfigCopiesWithoutABackup(backupsFolder: string): void {
  const backupStems = new Set(backupNamesIn(backupsFolder).map((name) => name.replace(/\.db$/, '')));
  for (const name of readdirSync(backupsFolder)) {
    const stem = CONFIG_COPY_NAME_PATTERN.exec(name)?.[1];
    const isOrphan = stem !== undefined && !backupStems.has(stem) && isRegularFile(join(backupsFolder, name));
    if (isOrphan) removeIfPresent(join(backupsFolder, name));
  }
}

export function pruneBackupsKeepingRecentSchemaVersions(backupsFolder: string, options: { justTakenPath: string; preUpgradeSnapshotName: string | undefined; knownVersions: ReadonlySet<string> }): void {
  try {
    const { knownVersions } = options;
    const justTakenName = basename(options.justTakenPath);
    const newestNameBySchemaVersion = newestBackupNameBySchemaVersion(backupsFolder, knownVersions, justTakenName);
    const keptVersions = retainedSchemaVersions(newestNameBySchemaVersion).slice(-SCHEMA_VERSIONS_TO_KEEP);
    const keptNames = new Set<string | undefined>([justTakenName, options.preUpgradeSnapshotName, ...keptVersions.map((version) => newestNameBySchemaVersion.get(version))]);
    for (const name of backupNamesIn(backupsFolder)) {
      const isShippedVersion = knownVersions.has(schemaVersionOf(name));
      if (isShippedVersion && !keptNames.has(name)) removeIfPresent(join(backupsFolder, name));
    }
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
