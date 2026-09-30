import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { refuseBootOnFailure } from '../bootFailure.js';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationVersions = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => f.replace(/\.sql$/, ''));
const sourceOf = (version: string) => ({ version, sql: readFileSync(join(migrationsDir, `${version}.sql`), 'utf8') });
const sourcesUpTo = (lastVersion: string) => migrationVersions.slice(0, migrationVersions.indexOf(lastVersion) + 1).map(sourceOf);

const MARKER_NAME = 'pre-upgrade.marker';
const REVIEWER_FIXTURE_TIMESTAMP = '2031-01-01T00-00-00-000Z';

let home: string;
let dbPath: string;
let backupsDir: string;
let markerPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'of-backup-marker-'));
  dbPath = join(home, 'openfleet.db');
  backupsDir = join(home, 'backups');
  markerPath = join(backupsDir, MARKER_NAME);
});

function createDatabaseWhere016Fails(lastVersion: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  applyMigrations(db, sourcesUpTo(lastVersion));
  db.exec(`CREATE TABLE newest_data (v TEXT); INSERT INTO newest_data VALUES ('written just before the upgrade')`);
  db.exec('ALTER TABLE sessions ADD COLUMN prompted INTEGER');
  db.close();
}

function repairSoThat016Succeeds(): void {
  const db = new DatabaseSync(dbPath);
  db.exec('ALTER TABLE sessions DROP COLUMN prompted');
  db.close();
}

const backupNamed = (version: string, timestamp: string) => `openfleet-${version}-${timestamp}.db`;
const databaseBackups = () => (existsSync(backupsDir) ? readdirSync(backupsDir).filter((name) => name.endsWith('.db')).sort() : []);
const backupOfVersion = (version: string) => databaseBackups().find((name) => name.startsWith(`openfleet-${version}-`))!;

function seedBackup(name: string): void {
  mkdirSync(backupsDir, { recursive: true });
  writeFileSync(join(backupsDir, name), 'seeded backup');
}

async function refusalLineOf(boot: () => unknown): Promise<string> {
  const written: string[] = [];
  await refuseBootOnFailure(async () => boot(), { configPath: 'x', writeStderr: (t) => written.push(t), exit: () => { throw new Error('exit'); } }).catch(() => undefined);
  expect(written).toHaveLength(1);
  return written[0]!;
}

const savedAt = (backupName: string) => `saved at ${join(backupsDir, backupName)}: quit the app`;

describe('the refusal line during a failure streak, with backups of older upgrades present', () => {
  it('names the snapshot from before the first attempt on every boot, and a 014-era app opens it with the newest data', async () => {
    seedBackup(backupNamed('012_session_cli_session_id', REVIEWER_FIXTURE_TIMESTAMP));
    seedBackup(backupNamed('013_working_state', REVIEWER_FIXTURE_TIMESTAMP));
    createDatabaseWhere016Fails('014_session_cli_ids');

    const lines: string[] = [];
    for (let boot = 0; boot < 4; boot++) lines.push(await refusalLineOf(() => openDatabase(dbPath)));

    const preUpgradeSnapshot = backupOfVersion('014_session_cli_ids');
    for (const line of lines) expect(line).toContain(savedAt(preUpgradeSnapshot));
    expect(readFileSync(markerPath, 'utf8')).toBe(preUpgradeSnapshot);
    const restored = new DatabaseSync(join(backupsDir, preUpgradeSnapshot), { readOnly: true });
    expect(restored.prepare('SELECT v FROM newest_data').all()).toEqual([{ v: 'written just before the upgrade' }]);
    expect(() => applyMigrations(restored as unknown as DatabaseSync, sourcesUpTo('014_session_cli_ids'))).not.toThrow();
    restored.close();
  });

  it('removes the marker after the successful boot and applies the usual retention again', async () => {
    seedBackup(backupNamed('012_session_cli_session_id', REVIEWER_FIXTURE_TIMESTAMP));
    seedBackup(backupNamed('013_working_state', REVIEWER_FIXTURE_TIMESTAMP));
    createDatabaseWhere016Fails('014_session_cli_ids');
    for (let boot = 0; boot < 4; boot++) await refusalLineOf(() => openDatabase(dbPath));
    repairSoThat016Succeeds();

    openDatabase(dbPath).close();

    expect(existsSync(markerPath)).toBe(false);
    expect(databaseBackups().map((name) => name.split('-')[1])).toEqual(['013_working_state', '014_session_cli_ids', '015_handovers']);
  });

  it('writes the marker with mode 0600 and nothing but the file name', async () => {
    createDatabaseWhere016Fails('014_session_cli_ids');

    await refusalLineOf(() => openDatabase(dbPath));

    expect(lstatSync(markerPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(markerPath, 'utf8')).toBe(backupOfVersion('014_session_cli_ids'));
  });
});

describe('a file named like a backup whose version no shipped migration carries', () => {
  it('takes no retention slot, does not evict the pre-upgrade snapshot, is never deleted and is never named', async () => {
    const foreign = [backupNamed('999_future', '2020-01-01T00-00-00-000Z'), backupNamed('zzz', '2020-01-01T00-00-00-000Z')];
    for (const name of foreign) seedBackup(name);
    createDatabaseWhere016Fails('014_session_cli_ids');

    const lines: string[] = [];
    for (let boot = 0; boot < 3; boot++) lines.push(await refusalLineOf(() => openDatabase(dbPath)));

    const preUpgradeSnapshot = backupOfVersion('014_session_cli_ids');
    for (const line of lines) {
      expect(line).toContain(savedAt(preUpgradeSnapshot));
      for (const name of foreign) expect(line).not.toContain(name);
    }
    expect(databaseBackups()).toEqual(expect.arrayContaining(foreign));
    repairSoThat016Succeeds();
    openDatabase(dbPath).close();
    expect(databaseBackups()).toEqual(expect.arrayContaining([...foreign, preUpgradeSnapshot]));
  });
});

describe('a marker that cannot be trusted', () => {
  async function bootFailingOnceThenReadTheHint(plantMarker: () => void): Promise<string> {
    createDatabaseWhere016Fails('015_handovers');
    mkdirSync(backupsDir, { recursive: true });
    plantMarker();
    return refusalLineOf(() => openDatabase(dbPath));
  }

  it('is replaced by this boot snapshot when it names a missing file', async () => {
    const line = await bootFailingOnceThenReadTheHint(() => writeFileSync(markerPath, backupNamed('013_working_state', REVIEWER_FIXTURE_TIMESTAMP)));

    const thisBootsSnapshot = backupOfVersion('015_handovers');
    expect(line).toContain(savedAt(thisBootsSnapshot));
    expect(readFileSync(markerPath, 'utf8')).toBe(thisBootsSnapshot);
  });

  it.each(['../outside.db', 'notes.txt', ''])('is replaced by this boot snapshot when it holds the invalid name %j', async (invalidName) => {
    const line = await bootFailingOnceThenReadTheHint(() => writeFileSync(markerPath, invalidName));

    const thisBootsSnapshot = backupOfVersion('015_handovers');
    expect(line).toContain(savedAt(thisBootsSnapshot));
    expect(readFileSync(markerPath, 'utf8')).toBe(thisBootsSnapshot);
  });

  it('is never followed when it is a symlink, and is replaced by a regular file', async () => {
    const existingBackup = backupNamed('013_working_state', REVIEWER_FIXTURE_TIMESTAMP);
    const outside = join(mkdtempSync(join(tmpdir(), 'of-backup-marker-outside-')), 'precious.txt');
    writeFileSync(outside, existingBackup);

    const line = await bootFailingOnceThenReadTheHint(() => {
      seedBackup(existingBackup);
      symlinkSync(outside, markerPath);
    });

    const thisBootsSnapshot = backupOfVersion('015_handovers');
    expect(line).toContain(savedAt(thisBootsSnapshot));
    expect(readFileSync(outside, 'utf8')).toBe(existingBackup);
    expect(lstatSync(markerPath).isFile()).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe(thisBootsSnapshot);
  });

  it('is ignored without failing the boot when it is a directory', async () => {
    const line = await bootFailingOnceThenReadTheHint(() => mkdirSync(markerPath));

    expect(line).toContain(savedAt(backupOfVersion('015_handovers')));
    expect(lstatSync(markerPath).isDirectory()).toBe(true);
  });
});

function execOnDatabase(statement: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(statement);
  db.close();
}

function restoreDatabaseFrom(backupName: string): void {
  for (const sideFile of [`${dbPath}-wal`, `${dbPath}-shm`]) rmSync(sideFile, { force: true });
  copyFileSync(join(backupsDir, backupName), dbPath);
}

const databaseBackupsOfVersion = (version: string) => databaseBackups().filter((name) => name.startsWith(`openfleet-${version}-`));

describe('a marker left over from an upgrade that is no longer in flight', () => {
  it('is replaced by this boot snapshot when the user restored the marked snapshot and used the old app since', async () => {
    createDatabaseWhere016Fails('013_working_state');
    await refusalLineOf(() => openDatabase(dbPath));
    const staleMarkedName = readFileSync(markerPath, 'utf8');
    restoreDatabaseFrom(staleMarkedName);
    execOnDatabase(`UPDATE newest_data SET v = 'months of work with the old app'`);

    const line = await refusalLineOf(() => openDatabase(dbPath));

    const thisBootsSnapshot = databaseBackupsOfVersion('013_working_state').pop()!;
    expect(line).toContain(savedAt(thisBootsSnapshot));
    expect(readFileSync(markerPath, 'utf8')).toBe(thisBootsSnapshot);
    const snapshot = new DatabaseSync(join(backupsDir, thisBootsSnapshot), { readOnly: true });
    expect(snapshot.prepare('SELECT v FROM newest_data').all()).toEqual([{ v: 'months of work with the old app' }]);
    snapshot.close();
  });

  it('is replaced by this boot snapshot when it looks valid but names a backup of the version the database still holds', async () => {
    const staleMarkedName = backupNamed('013_working_state', REVIEWER_FIXTURE_TIMESTAMP);
    seedBackup(staleMarkedName);
    createDatabaseWhere016Fails('013_working_state');
    writeFileSync(markerPath, staleMarkedName);

    const line = await refusalLineOf(() => openDatabase(dbPath));

    const thisBootsSnapshot = databaseBackupsOfVersion('013_working_state').filter((name) => name !== staleMarkedName).pop()!;
    expect(line).toContain(savedAt(thisBootsSnapshot));
    expect(line).not.toContain(staleMarkedName);
    expect(readFileSync(markerPath, 'utf8')).toBe(thisBootsSnapshot);
  });

  it('is deleted by a boot with nothing to migrate, so a crash before the marker was cleared leaves nothing behind', async () => {
    createDatabaseWhere016Fails('013_working_state');
    await refusalLineOf(() => openDatabase(dbPath));
    const markerLeftByTheCrash = readFileSync(markerPath, 'utf8');
    repairSoThat016Succeeds();
    openDatabase(dbPath).close();
    writeFileSync(markerPath, markerLeftByTheCrash);

    openDatabase(dbPath).close();

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not name the old snapshot in the newer-schema refusal once a boot with nothing to migrate deleted it', async () => {
    createDatabaseWhere016Fails('013_working_state');
    await refusalLineOf(() => openDatabase(dbPath));
    const markerLeftByTheCrash = readFileSync(markerPath, 'utf8');
    repairSoThat016Succeeds();
    openDatabase(dbPath).close();
    writeFileSync(markerPath, markerLeftByTheCrash);
    openDatabase(dbPath).close();
    execOnDatabase(`INSERT INTO schema_migrations (version, applied_at) VALUES ('999_newer', 'x')`);

    const line = await refusalLineOf(() => openDatabase(dbPath));

    expect(line).toContain(backupOfVersion('015_handovers'));
    expect(line).not.toContain(markerLeftByTheCrash);
  });
});

describe('a failure streak, marker validity follows the migrations that committed', () => {
  it('keeps the marker on the snapshot from before the first attempt while each boot commits one more migration', async () => {
    execOnDatabaseAfterCreating('012_session_cli_session_id', 'CREATE TABLE session_cli_ids (x); CREATE TABLE handovers (x); ALTER TABLE sessions ADD COLUMN prompted INTEGER');
    const lines: string[] = [];
    lines.push(await refusalLineOf(() => openDatabase(dbPath)));
    const preUpgradeSnapshot = readFileSync(markerPath, 'utf8');
    execOnDatabase('DROP TABLE session_cli_ids');
    lines.push(await refusalLineOf(() => openDatabase(dbPath)));
    execOnDatabase('DROP TABLE handovers');
    lines.push(await refusalLineOf(() => openDatabase(dbPath)));

    for (const line of lines) expect(line).toContain(savedAt(preUpgradeSnapshot));
    expect(preUpgradeSnapshot).toContain('openfleet-012_session_cli_session_id-');
  });

  it('replaces the marker by the equivalent snapshot of this boot when the previous boot committed nothing', async () => {
    execOnDatabaseAfterCreating('014_session_cli_ids', 'CREATE TABLE handovers (x)');
    await refusalLineOf(() => openDatabase(dbPath));
    const firstSnapshot = readFileSync(markerPath, 'utf8');

    const line = await refusalLineOf(() => openDatabase(dbPath));

    const secondSnapshot = readFileSync(markerPath, 'utf8');
    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(line).toContain(savedAt(secondSnapshot));
    expect(databaseBackupsOfVersion('014_session_cli_ids')).toEqual([secondSnapshot]);
  });

  it('keeps the marked snapshot after the success even when the streak backed up three more versions', async () => {
    execOnDatabaseAfterCreating('012_session_cli_session_id', 'CREATE TABLE session_cli_ids (x); CREATE TABLE handovers (x); ALTER TABLE sessions ADD COLUMN prompted INTEGER');
    await refusalLineOf(() => openDatabase(dbPath));
    const preUpgradeSnapshot = readFileSync(markerPath, 'utf8');
    execOnDatabase('DROP TABLE session_cli_ids');
    await refusalLineOf(() => openDatabase(dbPath));
    execOnDatabase('DROP TABLE handovers');
    await refusalLineOf(() => openDatabase(dbPath));
    repairSoThat016Succeeds();

    openDatabase(dbPath).close();

    expect(existsSync(markerPath)).toBe(false);
    expect(databaseBackups()).toContain(preUpgradeSnapshot);
  });
});

function execOnDatabaseAfterCreating(lastVersion: string, statements: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  applyMigrations(db, sourcesUpTo(lastVersion));
  db.exec(statements);
  db.close();
}

describe('a successful boot that never failed', () => {
  it('deletes no other backup and leaves no marker', () => {
    const older = backupNamed('013_working_state', REVIEWER_FIXTURE_TIMESTAMP);
    seedBackup(older);
    createDatabaseWhere016Fails('014_session_cli_ids');
    repairSoThat016Succeeds();

    openDatabase(dbPath).close();

    expect(databaseBackups()).toHaveLength(2);
    expect(databaseBackups()).toContain(older);
    expect(existsSync(markerPath)).toBe(false);
  });
});
