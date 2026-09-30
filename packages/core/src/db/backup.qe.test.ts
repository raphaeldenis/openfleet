import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
const previousVersion = migrationVersions[migrationVersions.length - 2]!;

let home: string;
let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'of-backup-qe-'));
  dbPath = join(home, 'openfleet.db');
  backupsDir = join(home, 'backups');
});

afterEach(() => {
  vi.useRealTimers();
});

function createDatabaseOneMigrationBehind(at: string = dbPath): DatabaseSync {
  const db = new DatabaseSync(at);
  db.exec('PRAGMA journal_mode = WAL');
  const sources = migrationVersions.slice(0, -1).map((version) => ({ version, sql: readFileSync(join(migrationsDir, `${version}.sql`), 'utf8') }));
  applyMigrations(db, sources);
  return db;
}

function bootOneMigrationBehindDatabase(): void {
  createDatabaseOneMigrationBehind().close();
  openDatabase(dbPath).close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
}

const modeOf = (path: string) => statSync(path).mode & 0o777;
const databaseBackups = () => readdirSync(backupsDir).filter((name) => name.endsWith('.db')).sort();

describe('pre-migration backup folder permissions', () => {
  it('tightens a backups folder that already exists with looser permissions', () => {
    createDatabaseOneMigrationBehind().close();
    mkdirSync(backupsDir, { mode: 0o755 });
    chmodSync(backupsDir, 0o755);

    openDatabase(dbPath).close();

    expect(modeOf(backupsDir)).toBe(0o700);
  });
});

describe('pre-migration backup retention order', () => {
  it.fails('keeps the newest three when more than nine backups share one millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T05:05:05.005Z'));
    for (let boot = 0; boot < 11; boot++) bootOneMigrationBehindDatabase();

    const counterOf = (name: string) => Number(name.match(/Z(?:-(\d+))?\.db$/)![1] ?? 1);
    expect(databaseBackups().map(counterOf).sort((a, b) => a - b)).toEqual([9, 10, 11]);
  });

  it('drops the oldest backup by time even when an older backup carries a higher schema version in its name', () => {
    mkdirSync(backupsDir, { recursive: true });
    for (const day of ['01', '02', '03']) writeFileSync(join(backupsDir, `openfleet-999_from_the_future-2026-01-${day}T00-00-00-000Z.db`), 'old');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

    bootOneMigrationBehindDatabase();

    const remaining = databaseBackups();
    expect(remaining).toHaveLength(3);
    expect(remaining.some((name) => name.includes('2026-02-01T00-00-00-000Z'))).toBe(true);
    expect(remaining.some((name) => name.includes('2026-01-01T00-00-00-000Z'))).toBe(false);
  });

  it('orders same-millisecond backups by their counter as a number, not as text', () => {
    mkdirSync(backupsDir, { recursive: true });
    const sameMillisecond = '2026-01-01T00-00-00-000Z';
    const stem = `openfleet-${previousVersion}-${sameMillisecond}`;
    for (const name of [`${stem}.db`, `${stem}-8.db`, `${stem}-9.db`, `${stem}-10.db`]) writeFileSync(join(backupsDir, name), 'old');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    bootOneMigrationBehindDatabase();

    expect(databaseBackups()).toEqual([`${stem}-10.db`, `${stem}-8.db`, `${stem}-9.db`]);
  });
});

describe('pre-migration backup pruning around strange entries', () => {
  it.fails('boots and leaves a directory named like a backup alone', () => {
    mkdirSync(backupsDir, { recursive: true });
    const strangerDirectory = join(backupsDir, 'openfleet-015_x-2026-01-01T00-00-00-000Z.db');
    mkdirSync(strangerDirectory);
    writeFileSync(join(strangerDirectory, 'mine.txt'), 'mine');
    for (const day of ['02', '03', '04']) writeFileSync(join(backupsDir, `openfleet-015_x-2026-01-${day}T00-00-00-000Z.db`), 'old');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

    expect(() => bootOneMigrationBehindDatabase()).not.toThrow();

    expect(readFileSync(join(strangerDirectory, 'mine.txt'), 'utf8')).toBe('mine');
  });

  it('removes a symlink named like an old backup without touching what it points to', () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'of-backup-qe-outside-')), 'precious.txt');
    writeFileSync(outside, 'precious');
    mkdirSync(backupsDir, { recursive: true });
    symlinkSync(outside, join(backupsDir, 'openfleet-015_x-2026-01-01T00-00-00-000Z.db'));
    for (const day of ['02', '03', '04']) writeFileSync(join(backupsDir, `openfleet-015_x-2026-01-${day}T00-00-00-000Z.db`), 'old');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

    bootOneMigrationBehindDatabase();

    expect(readFileSync(outside, 'utf8')).toBe('precious');
  });

  it('refuses to boot and leaves the schema alone when the home directory is read-only', () => {
    createDatabaseOneMigrationBehind().close();
    chmodSync(home, 0o500);

    try {
      expect(() => openDatabase(dbPath)).toThrow();
    } finally {
      chmodSync(home, 0o700);
    }

    const untouched = new DatabaseSync(dbPath);
    const applied = (untouched.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]).map((r) => r.version);
    untouched.close();
    expect(applied).toEqual(migrationVersions.slice(0, -1));
  });
});

describe('the refusal line for a database newer than the code', () => {
  async function refusalLineFor(databaseFile: string): Promise<string> {
    const written: string[] = [];
    await refuseBootOnFailure(async () => openDatabase(databaseFile), { configPath: 'x', writeStderr: (t) => written.push(t), exit: () => { throw new Error('exit'); } }).catch(() => undefined);
    expect(written).toHaveLength(1);
    return written[0]!;
  }

  function createFutureDatabaseAt(databaseFile: string): void {
    const db = createDatabaseOneMigrationBehind(databaseFile);
    db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES ('999_from_the_future', 'now')`);
    db.close();
  }

  it('stays one line without control characters and still names the restore step for a long home path holding a control character', async () => {
    const longFolder = join(home, `${'d'.repeat(120)}\u0007${'e'.repeat(120)}`);
    mkdirSync(longFolder);
    const databaseFile = join(longFolder, 'openfleet.db');
    createFutureDatabaseAt(databaseFile);

    const line = await refusalLineFor(databaseFile);

    expect(line.slice(0, -1)).not.toMatch(/[\p{Cc}]/u);
    expect(line.endsWith('\n')).toBe(true);
    expect(line).toContain('999_from_the_future');
    expect(line).toMatch(/over openfleet\.db with the app quit, or install the newer app\)\n$/);
  });

  it.fails('names the backups folder next to the database path it was given when openfleet.db is a symlink', async () => {
    const realFolder = join(home, 'real');
    mkdirSync(realFolder);
    createFutureDatabaseAt(join(realFolder, 'openfleet.db'));
    symlinkSync(join(realFolder, 'openfleet.db'), dbPath);

    const line = await refusalLineFor(dbPath);

    expect(line).toContain(join(dirname(dbPath), 'backups'));
  });
});
