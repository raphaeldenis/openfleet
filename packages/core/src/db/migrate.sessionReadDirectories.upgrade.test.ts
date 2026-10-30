import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const readDirectoriesDownMigration = new URL('./migrations-down/059_session_read_directories.down.sql', import.meta.url);

const migrationsUpTo = (lastFileName: string) =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql') && fileName <= lastFileName)
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const databaseUpTo = (lastFileName: string): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsUpTo(lastFileName));
  return db;
};

const BEFORE_READ_DIRECTORIES = '058_session_attended.sql';
const WITH_READ_DIRECTORIES = '059_session_read_directories.sql';

const columnNamesOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);

const insertSession = (db: DatabaseSync, id: string) =>
  db.exec(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('${id}', 'Lead', '/tmp', 'fake', 'idle', 't', 'hook-${id}', 'mcp-${id}', 't')`);

const readDirectoriesOf = (db: DatabaseSync, id: string) => (db.prepare('SELECT read_directories FROM sessions WHERE id = ?').get(id) as { read_directories: string | null }).read_directories;

describe('migration 059, the read directories of a session', () => {
  it('leaves every session that existed before the migration with NULL read directories', () => {
    const db = databaseUpTo(BEFORE_READ_DIRECTORIES);
    insertSession(db, 's1');

    applyMigrations(db, migrationsUpTo(WITH_READ_DIRECTORIES));

    expect(readDirectoriesOf(db, 's1')).toBeNull();
  });

  it('gives a session created without read directories NULL', () => {
    const db = databaseUpTo(WITH_READ_DIRECTORIES);

    insertSession(db, 's1');

    expect(readDirectoriesOf(db, 's1')).toBeNull();
  });

  it('is undone by its down migration, which drops the column and keeps the sessions', () => {
    const databaseBefore = databaseUpTo(BEFORE_READ_DIRECTORIES);
    const databaseAfter = databaseUpTo(WITH_READ_DIRECTORIES);
    insertSession(databaseAfter, 's1');

    databaseAfter.exec(readFileSync(readDirectoriesDownMigration, 'utf8'));

    expect(columnNamesOf(databaseAfter, 'sessions')).toEqual(columnNamesOf(databaseBefore, 'sessions'));
    expect(databaseAfter.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });
});
