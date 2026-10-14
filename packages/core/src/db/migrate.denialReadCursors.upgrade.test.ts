import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const denialReadCursorsMigrationFileName = '031_denial_read_cursors.sql';

const migrationsBeforeDenialReadCursors = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < denialReadCursorsMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertDenial = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO denied_commands (id, session_id, manager_id, role, profile, harness, rule_id, decision_source, outcome, tool_name, command_excerpt, alternative, actor, created_at)
    VALUES (?, 'worker', 'lead', 'DEV', 'dev', 'fake', 'no-forced-recursive-rm', 'policy', 'denied', 'Bash', 'rm -rf x', NULL, 'session', 't1')`).run(id);

const upgradedDatabaseWithOneDenial = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeDenialReadCursors);
  insertDenial(db, 'd1');
  applyMigrations(db);
  return db;
};

describe('the denial read cursors migration upgrading a database that predates it', () => {
  it('keeps the journal and starts with no cursor: every existing denial is unseen', () => {
    const db = upgradedDatabaseWithOneDenial();

    expect(db.prepare('SELECT count(*) AS n FROM denied_commands').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM denial_read_cursors').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps one cursor per manager', () => {
    const db = upgradedDatabaseWithOneDenial();
    db.prepare("INSERT INTO denial_read_cursors (manager_id, last_seen_rowid) VALUES ('lead', 1)").run();

    expect(() => db.prepare("INSERT INTO denial_read_cursors (manager_id, last_seen_rowid) VALUES ('lead', 2)").run()).toThrow(/UNIQUE|PRIMARY/);
  });

  it('keeps the cursor of a manager after its session is deleted from the sessions table', () => {
    const db = upgradedDatabaseWithOneDenial();
    db.prepare("INSERT INTO denial_read_cursors (manager_id, last_seen_rowid) VALUES ('lead', 1)").run();

    expect(db.prepare('SELECT last_seen_rowid FROM denial_read_cursors WHERE manager_id = ?').get('lead')).toEqual({ last_seen_rowid: 1 });
  });
});
