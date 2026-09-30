import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
