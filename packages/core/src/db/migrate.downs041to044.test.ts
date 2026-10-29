import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const migrationsUpTo = (lastFileName: string) =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql') && fileName <= lastFileName)
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const DOWN_FILE_NAMES_NEWEST_FIRST = [
  '044_session_config_dir.down.sql',
  '043_ds_row_history_seq.down.sql',
  '042_project_row_guard.down.sql',
  '041_session_launch_readiness.down.sql',
];

const databaseUpTo = (lastFileName: string): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsUpTo(lastFileName));
  return db;
};

const runDowns = (db: DatabaseSync) => {
  for (const fileName of DOWN_FILE_NAMES_NEWEST_FIRST) db.exec(readFileSync(new URL(fileName, migrationsDownDirectory), 'utf8'));
};

// A renamed table is stored with quoted names, so quotes and spacing are not part of the schema being compared.
const normalizedSchemaOf = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[])
    .map(({ name, sql }) => `${name}: ${sql.replaceAll('"', '').replace(/\s+/g, ' ').trim()}`);

describe('the down migrations 044 to 041', () => {
  it('bring the schema back to what it was before migration 041', () => {
    const databaseBefore041 = databaseUpTo('040_review_step_skip_provenance.sql');
    const databaseDescendedFrom044 = databaseUpTo('044_session_config_dir.sql');

    runDowns(databaseDescendedFrom044);

    expect(normalizedSchemaOf(databaseDescendedFrom044)).toEqual(normalizedSchemaOf(databaseBefore041));
  });

  it('keep every history entry of a data store in its reading order and drop only seq', () => {
    const db = databaseUpTo('044_session_config_dir.sql');
    db.exec('PRAGMA foreign_keys = OFF;');
    const insertEntry = db.prepare("INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES (?, 's1', 'r1', 'human', 'me', '{}', ?)");
    insertEntry.run('third', 't3');
    insertEntry.run('first', 't1');
    insertEntry.run('second', 't2');
    const readingOrderBefore = (db.prepare('SELECT id, created_at FROM ds_row_history ORDER BY seq').all() as { id: string; created_at: string }[]);

    runDowns(db);

    const entriesAfter = db.prepare('SELECT * FROM ds_row_history ORDER BY rowid').all() as { id: string; created_at: string }[];
    expect(entriesAfter.map(({ id, created_at }) => ({ id, created_at }))).toEqual(readingOrderBefore);
    expect(Object.keys(entriesAfter[0]!)).not.toContain('seq');
  });
});
