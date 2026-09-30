import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refuseBootOnFailure } from '../bootFailure.js';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationVersions = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => f.replace(/\.sql$/, ''));
const sourceOf = (version: string) => ({ version, sql: readFileSync(join(migrationsDir, `${version}.sql`), 'utf8') });

let home: string;
let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'of-backup-review-'));
  dbPath = join(home, 'openfleet.db');
  backupsDir = join(home, 'backups');
});

afterEach(() => {
  vi.useRealTimers();
});

function createDatabaseAtVersion(lastVersion: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  applyMigrations(db, migrationVersions.slice(0, migrationVersions.indexOf(lastVersion) + 1).map(sourceOf));
  return db;
}

const databaseBackups = () => (existsSync(backupsDir) ? readdirSync(backupsDir).filter((name) => name.endsWith('.db')).sort() : []);
const highestVersionIn = (backupName: string) => {
  const backup = new DatabaseSync(join(backupsDir, backupName), { readOnly: true });
  const versions = (backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]).map((r) => r.version);
  backup.close();
  return versions.pop();
};

async function refusalLineOf(boot: () => unknown): Promise<string> {
  const written: string[] = [];
  await refuseBootOnFailure(async () => boot(), { configPath: 'x', writeStderr: (t) => written.push(t), exit: () => { throw new Error('exit'); } }).catch(() => undefined);
  expect(written).toHaveLength(1);
  return written[0]!;
}

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
}

describe('retention keeps the three most recently created backups', () => {
  it('keeps them even when the clock went backwards between the backups', () => {
    vi.useFakeTimers();
    const namedAt = ['2030-01-01', '2030-01-02', '2030-01-03', '2026-01-01', '2026-01-02'];
    const createdAt = new Date('2025-06-01T00:00:00.000Z').getTime();
    namedAt.forEach((day, creationOrder) => {
      vi.setSystemTime(new Date(`${day}T00:00:00.000Z`));
      createDatabaseAtVersion('015_handovers').close();
      openDatabase(dbPath).close();
      removeDatabaseFiles();
      const justTaken = databaseBackups().find((name) => name.includes(`${day}T00-00-00-000Z`))!;
      const creationTime = new Date(createdAt + creationOrder * 86_400_000);
      utimesSync(join(backupsDir, justTaken), creationTime, creationTime);
    });

    expect(databaseBackups().map((name) => name.match(/(\d{4}-\d{2}-\d{2})T/)![1])).toEqual(['2026-01-01', '2026-01-02', '2030-01-03']);
  });
});

describe('the restore instruction for a database newer than the code', () => {
  it('tells to quit the app, delete the -wal and -shm files, then copy the newest backup .db over openfleet.db, on one line', async () => {
    const db = createDatabaseAtVersion('015_handovers');
    db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES ('999_future', 'now')`);
    db.close();

    const line = await refusalLineOf(() => openDatabase(dbPath));

    expect(line.slice(0, -1)).not.toMatch(/\p{Cc}/u);
    expect(line).toContain(`quit the app, delete openfleet.db-wal and openfleet.db-shm, then copy the newest .db backup in ${backupsDir}, never a .config.json copy, over openfleet.db`);
  });

  it('is necessary: copying only the backup over a database left with a stale WAL replays the newer rows', () => {
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('before migration')");
      db.exec("VACUUM INTO '" + process.argv[2] + "'");
      db.exec("INSERT INTO t VALUES ('after migration')");
      process.exit(0);
    `;
    const restoreAfterAbruptExit = (deleteWalAndShm: boolean) => {
      const folder = mkdtempSync(join(home, 'restore-'));
      const databaseFile = join(folder, 'openfleet.db');
      const backupPath = join(folder, 'backup.db');
      spawnSync(process.execPath, ['-e', script, databaseFile, backupPath], { stdio: 'inherit' });
      expect(existsSync(`${databaseFile}-wal`)).toBe(true);
      if (deleteWalAndShm) for (const side of ['-wal', '-shm']) unlinkSync(`${databaseFile}${side}`);
      copyFileSync(backupPath, databaseFile);
      const db = new DatabaseSync(databaseFile);
      const rows = (db.prepare('SELECT v FROM t ORDER BY v').all() as { v: string }[]).map((r) => r.v);
      db.close();
      return rows;
    };

    const copyingOnlyTheBackup = restoreAfterAbruptExit(false);
    const alsoDeletingWalAndShm = restoreAfterAbruptExit(true);

    expect(copyingOnlyTheBackup).toEqual(['after migration', 'before migration']);
    expect(alsoDeletingWalAndShm).toEqual(['before migration']);
  });
});

describe('the config copy beside a backup', () => {
  const takenAt = '2026-05-05T05:05:05.005Z';
  const sidecarName = 'openfleet-015_handovers-2026-05-05T05-05-05-005Z.config.json';

  function bootWithSomethingAlreadyNamedLikeTheConfigCopy(plantCollision: () => void): void {
    writeFileSync(join(home, 'config.json'), '{"secret":"synthetic"}');
    createDatabaseAtVersion('015_handovers').close();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(takenAt));
    mkdirSync(backupsDir);
    plantCollision();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openDatabase(dbPath).close();
  }

  it('never writes through a symlink that already has its name', () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'of-backup-review-outside-')), 'precious.txt');
    writeFileSync(outside, 'precious');

    bootWithSomethingAlreadyNamedLikeTheConfigCopy(() => symlinkSync(outside, join(backupsDir, sidecarName)));

    expect(readFileSync(outside, 'utf8')).toBe('precious');
    expect(lstatSync(join(backupsDir, sidecarName)).isSymbolicLink()).toBe(true);
    expect(databaseBackups()).toHaveLength(1);
  });

  it('never overwrites a regular file that already has its name', () => {
    bootWithSomethingAlreadyNamedLikeTheConfigCopy(() => writeFileSync(join(backupsDir, sidecarName), 'mine'));

    expect(readFileSync(join(backupsDir, sidecarName), 'utf8')).toBe('mine');
  });
});

describe('pruning orphan config copies', () => {
  it('removes a config copy whose backup is gone or was pruned, and keeps the copies of the kept backups', () => {
    mkdirSync(backupsDir);
    const stem = (day: string) => `openfleet-014_session_cli_ids-2026-01-${day}T00-00-00-000Z`;
    writeFileSync(join(backupsDir, `${stem('01')}.config.json`), 'orphan');
    for (const day of ['02', '03']) {
      writeFileSync(join(backupsDir, `${stem(day)}.db`), 'kept');
      writeFileSync(join(backupsDir, `${stem(day)}.config.json`), 'kept');
    }
    writeFileSync(join(backupsDir, 'other.config.json'), 'mine');
    createDatabaseAtVersion('015_handovers').close();

    openDatabase(dbPath).close();

    const configCopies = readdirSync(backupsDir).filter((name) => name.endsWith('.config.json'));
    expect(configCopies).not.toContain(`${stem('01')}.config.json`);
    expect(configCopies).toContain(`${stem('02')}.config.json`);
    expect(configCopies).toContain(`${stem('03')}.config.json`);
    expect(readFileSync(join(backupsDir, 'other.config.json'), 'utf8')).toBe('mine');
  });
});

describe('a boot that fails or is refused never evicts the pre-upgrade backup', () => {
  it('keeps the backup taken before 015 across four boots where 015 commits and 016 keeps failing', () => {
    const db = createDatabaseAtVersion('014_session_cli_ids');
    db.exec('ALTER TABLE sessions ADD COLUMN prompted INTEGER');
    db.close();

    for (let boot = 0; boot < 4; boot++) expect(() => openDatabase(dbPath)).toThrow(/duplicate column name: prompted/);

    expect(databaseBackups().map(highestVersionIn)).toContain('014_session_cli_ids');
  });

  it('takes no backup and prunes nothing when the database names a migration this code does not know', () => {
    const db = createDatabaseAtVersion('015_handovers');
    db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES ('999_future', 'now')`);
    db.close();
    mkdirSync(backupsDir);
    const existing = ['2026-01-01', '2026-01-02', '2026-01-03'].map((day) => `openfleet-014_session_cli_ids-${day}T00-00-00-000Z.db`);
    for (const name of existing) writeFileSync(join(backupsDir, name), 'valid rollback');

    for (let boot = 0; boot < 4; boot++) expect(() => openDatabase(dbPath)).toThrow(/999_future/);

    expect(databaseBackups()).toEqual(existing);
  });

  it('takes no backup when a pending migration meets an applied migration whose checksum no longer matches', () => {
    const db = createDatabaseAtVersion('015_handovers');
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('0'.repeat(64), '001_init');
    db.close();

    expect(() => openDatabase(dbPath)).toThrow(/checksum mismatch/);

    expect(existsSync(backupsDir)).toBe(false);
  });
});
