import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseOpenError, openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

const LOCK_HELD_MS = 500;

describe('openDatabase', () => {
  it('creates the schema and records applied migrations', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['sessions', 'message_queue', 'approvals', 'schema_migrations']));
    const applied = db.prepare('SELECT version FROM schema_migrations').all();
    expect(applied).toContainEqual({ version: '001_init' });
  });

  it('does not re-apply an already-applied migration to the same connection', () => {
    const db = openDatabase(':memory:');
    const appliedCountBefore = db.prepare('SELECT count(*) AS n FROM schema_migrations').get();

    expect(() => applyMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual(appliedCountBefore);
  });

  it('sets a busy_timeout so a second writer waits instead of failing immediately', () => {
    const db = openDatabase(':memory:');

    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
  });

  it('waits for another process holding the database locked instead of failing the boot immediately', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'of-db-locked-')), 'openfleet.db');
    const lockHeldBriefly = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('CREATE TABLE held (id INTEGER); BEGIN EXCLUSIVE');
      process.stdout.write('locked\\n');
      setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, ${LOCK_HELD_MS});
    `;
    const otherProcess = spawn(process.execPath, ['-e', lockHeldBriefly, dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(otherProcess.stdout, 'data');

    const opening = () => openDatabase(dbPath).close();

    expect(opening).not.toThrow();
    await once(otherProcess, 'exit');
  });

  it('forces the db file (and its -wal/-shm side files, once WAL creates them) to 0600 (AUD-05)', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'of-db-')), 'openfleet.db');

    openDatabase(dbPath);

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(side)) expect(statSync(side).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a database file it cannot open with an error that names the path', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-db-unopenable-'));
    const dbPath = join(home, 'openfleet.db');
    mkdirSync(dbPath);

    const opening = () => openDatabase(dbPath);

    expect(opening).toThrow(DatabaseOpenError);
    expect(opening).toThrow(`cannot open the database at ${dbPath}`);
    rmSync(home, { recursive: true });
  });
});
