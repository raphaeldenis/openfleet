import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsUpTo008 = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '009')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
    VALUES (?, 'existing', '/tmp', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0')`).run(id, `h-${id}`, `m-${id}`);
};

const openDatabaseUpgradedFrom008 = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsUpTo008);
  insertSession(db, 's1');
  applyMigrations(db);
  return db;
};

describe('the resolved model migration upgrading a database at version 008', () => {
  it('keeps every existing session untouched, with no resolved model, cli version or drift recorded', () => {
    const db = openDatabaseUpgradedFrom008();

    const sessions = db.prepare('SELECT id, model, branch, resolved_model, cli_version, model_drifted_from FROM sessions').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(sessions).toEqual([{ id: 's1', model: 'opus', branch: 'main', resolved_model: null, cli_version: null, model_drifted_from: null }]);
    expect(foreignKeyViolations).toEqual([]);
  });
});
