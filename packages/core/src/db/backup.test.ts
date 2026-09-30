import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refuseBootOnFailure } from '../bootFailure.js';
import { openDatabase } from './database.js';
import { applyMigrations, pendingMigrations } from './migrate.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationVersions = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => f.replace(/\.sql$/, ''));
const newestVersion = migrationVersions[migrationVersions.length - 1]!;
const previousVersion = migrationVersions[migrationVersions.length - 2]!;

let home: string;
let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'of-backup-'));
  dbPath = join(home, 'openfleet.db');
  backupsDir = join(home, 'backups');
});

afterEach(() => {
  vi.useRealTimers();
});

function createDatabaseOneMigrationBehind(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  const sources = migrationVersions.slice(0, -1).map((version) => ({ version, sql: readFileSync(join(migrationsDir, `${version}.sql`), 'utf8') }));
  applyMigrations(db, sources);
  db.exec(`CREATE TABLE marker (note TEXT); INSERT INTO marker VALUES ('old row')`);
  return db;
}

function createDatabaseOneMigrationBehindAndClose(): void {
  createDatabaseOneMigrationBehind().close();
}

const backupFiles = () => (existsSync(backupsDir) ? readdirSync(backupsDir).sort() : []);
const databaseBackups = () => backupFiles().filter((name) => name.endsWith('.db'));
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe('pendingMigrations', () => {
  it('lists the migration files the database has not applied', () => {
    const db = createDatabaseOneMigrationBehind();

    expect(pendingMigrations(db)).toEqual([newestVersion]);
  });

  it('lists every migration for a database that never ran any', () => {
    const db = new DatabaseSync(':memory:');

    expect(pendingMigrations(db)).toEqual(migrationVersions);
  });
});

describe('pre-migration backup', () => {
  it('takes no backup when nothing is pending', () => {
    openDatabase(dbPath).close();

    openDatabase(dbPath).close();

    expect(backupFiles()).toEqual([]);
  });

  it('takes no backup for a brand-new database', () => {
    openDatabase(dbPath).close();

    expect(existsSync(backupsDir)).toBe(false);
  });

  it('takes one backup that holds the old rows and the old schema version when a migration is pending', () => {
    createDatabaseOneMigrationBehindAndClose();
    writeFileSync(join(home, 'config.json'), '{"port":7331}');

    openDatabase(dbPath).close();

    const [backupName, ...others] = databaseBackups();
    expect(others).toEqual([]);
    expect(backupName).toMatch(new RegExp(`^openfleet-${previousVersion}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.db$`));
    const backup = new DatabaseSync(join(backupsDir, backupName!), { readOnly: true });
    expect(backup.prepare('SELECT note FROM marker').all()).toEqual([{ note: 'old row' }]);
    const backedUpVersions = (backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]).map((r) => r.version);
    expect(backedUpVersions).toEqual(migrationVersions.slice(0, -1));
    backup.close();
    expect(modeOf(join(backupsDir, backupName!))).toBe(0o600);
    expect(modeOf(backupsDir)).toBe(0o700);
    const configCopy = join(backupsDir, backupName!.replace(/\.db$/, '.config.json'));
    expect(readFileSync(configCopy, 'utf8')).toBe('{"port":7331}');
    expect(modeOf(configCopy)).toBe(0o600);
  });

  it('takes the backup without a config copy when config.json does not exist', () => {
    createDatabaseOneMigrationBehindAndClose();

    openDatabase(dbPath).close();

    expect(backupFiles().filter((name) => name.endsWith('.config.json'))).toEqual([]);
  });

  it('names the backup path in the boot log line', () => {
    createDatabaseOneMigrationBehindAndClose();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    openDatabase(dbPath).close();

    const lines = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();
    expect(lines.some((line) => line.includes(join(backupsDir, databaseBackups()[0]!)))).toBe(true);
  });

  it('keeps only the newest backup of a schema version and deletes the older db and config pair', () => {
    writeFileSync(join(home, 'config.json'), '{}');
    vi.useFakeTimers();
    const names: string[] = [];
    for (const isoTimestamp of ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']) {
      vi.setSystemTime(new Date(isoTimestamp));
      createDatabaseOneMigrationBehindAndClose();
      openDatabase(dbPath).close();
      names.push(...databaseBackups().filter((name) => !names.includes(name)));
      rmDatabaseFiles();
    }

    expect(databaseBackups()).toEqual([names[1]]);
    expect(backupFiles().filter((name) => name.endsWith('.config.json'))).toEqual([names[1]!.replace(/\.db$/, '.config.json')]);
  });

  it('names backups so that sorting the names sorts them chronologically', () => {
    vi.useFakeTimers();
    const names: string[] = [];
    for (const isoTimestamp of ['2026-03-01T10:00:00.000Z', '2026-03-01T09:00:00.000Z', '2026-12-01T00:00:00.000Z']) {
      vi.setSystemTime(new Date(isoTimestamp));
      createDatabaseOneMigrationBehindAndClose();
      openDatabase(dbPath).close();
      names.push(...databaseBackups().filter((name) => !names.includes(name)));
      rmDatabaseFiles();
    }

    expect([...names].sort().map((name) => name.match(/(\d{4}-.*Z)/)![1])).toEqual([
      '2026-03-01T09-00-00-000Z',
      '2026-03-01T10-00-00-000Z',
      '2026-12-01T00-00-00-000Z',
    ]);
  });

  it('never deletes a file in backups/ that does not match the backup name pattern', () => {
    mkdirSync(backupsDir, { recursive: true });
    const strangers = ['notes.txt', 'openfleet-keep-me.db', 'openfleet-016_x-2026-01-01T00-00-00-000Z.db.bak', 'other.config.json'];
    for (const name of strangers) writeFileSync(join(backupsDir, name), 'mine');
    vi.useFakeTimers();
    for (const day of ['01', '02', '03', '04', '05']) {
      vi.setSystemTime(new Date(`2026-02-${day}T00:00:00.000Z`));
      createDatabaseOneMigrationBehindAndClose();
      openDatabase(dbPath).close();
      rmDatabaseFiles();
    }

    for (const name of strangers) expect(readFileSync(join(backupsDir, name), 'utf8')).toBe('mine');
    expect(databaseBackups().filter((name) => !strangers.includes(name))).toHaveLength(1);
  });

  it('never deletes anything outside the backups folder', () => {
    writeFileSync(join(home, 'openfleet-016_x-2026-01-01T00-00-00-000Z.db'), 'sibling');
    vi.useFakeTimers();
    for (const day of ['01', '02', '03', '04']) {
      vi.setSystemTime(new Date(`2026-02-${day}T00:00:00.000Z`));
      createDatabaseOneMigrationBehindAndClose();
      openDatabase(dbPath).close();
      rmDatabaseFiles();
    }

    expect(readFileSync(join(home, 'openfleet-016_x-2026-01-01T00-00-00-000Z.db'), 'utf8')).toBe('sibling');
  });

  it('gives a second backup taken in the same millisecond its own counter-suffixed name', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T05:05:05.005Z'));
    const names: string[] = [];
    for (let boot = 0; boot < 2; boot++) {
      createDatabaseOneMigrationBehindAndClose();
      openDatabase(dbPath).close();
      names.push(...databaseBackups().filter((name) => !names.includes(name)));
      rmDatabaseFiles();
    }

    expect(names).toHaveLength(2);
    expect(names[1]).toMatch(/Z-2\.db$/);
    expect(databaseBackups()).toEqual([names[1]]);
    expect(() => new DatabaseSync(join(backupsDir, names[1]!), { readOnly: true }).close()).not.toThrow();
  });

  it('holds the WAL content that never reached the main db file', () => {
    const writer = createDatabaseOneMigrationBehind();
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    writer.exec(`INSERT INTO marker VALUES ('only in the wal')`);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    openDatabase(dbPath).close();
    writer.close();

    const backup = new DatabaseSync(join(backupsDir, databaseBackups()[0]!), { readOnly: true });
    expect(backup.prepare('SELECT note FROM marker ORDER BY note').all()).toEqual([{ note: 'old row' }, { note: 'only in the wal' }]);
    backup.close();
  });

  it('refuses to boot when the backup cannot be written and leaves the database un-migrated', () => {
    createDatabaseOneMigrationBehindAndClose();
    writeFileSync(backupsDir, 'a file where the backups folder should be');

    expect(() => openDatabase(dbPath)).toThrow(/backup/i);

    const untouched = new DatabaseSync(dbPath);
    const applied = (untouched.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]).map((r) => r.version);
    untouched.close();
    expect(applied).toEqual(migrationVersions.slice(0, -1));
  });

  it('prints a one-line refusal that names the failed backup', async () => {
    createDatabaseOneMigrationBehindAndClose();
    writeFileSync(backupsDir, 'a file where the backups folder should be');
    const written: string[] = [];

    await refuseBootOnFailure(async () => openDatabase(dbPath), { configPath: 'x', writeStderr: (t) => written.push(t), exit: () => { throw new Error('exit'); } }).catch(() => undefined);

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^openfleet: refusing to boot: .*backup.*\n$/);
  });
});

describe('a database newer than the code', () => {
  function createDatabaseFromTheFuture(): void {
    const db = createDatabaseOneMigrationBehind();
    db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES ('999_from_the_future', 'now')`);
    db.close();
  }

  it('is refused with a line that says where the backups are and how to restore', async () => {
    createDatabaseFromTheFuture();
    const written: string[] = [];

    await refuseBootOnFailure(async () => openDatabase(dbPath), { configPath: 'x', writeStderr: (t) => written.push(t), exit: () => { throw new Error('exit'); } }).catch(() => undefined);

    expect(written).toHaveLength(1);
    const line = written[0]!;
    expect(line.endsWith('\n') && line.indexOf('\n') === line.length - 1).toBe(true);
    expect(line).toContain('999_from_the_future');
    expect(line).toContain(backupsDir);
    expect(line).toMatch(/quit the app, delete openfleet\.db-wal and openfleet\.db-shm, then copy the \.db backup named openfleet-.* in .* over openfleet\.db; or install the newer app/);
  });
});

function rmDatabaseFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}
