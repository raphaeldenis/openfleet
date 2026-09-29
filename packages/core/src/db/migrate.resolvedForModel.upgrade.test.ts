import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const resolvedForModelMigrationFileName = readdirSync(migrationsDirectory).find((fileName) => fileName.endsWith('_session_resolved_for_model.sql'))!;

const migrationsBeforeResolvedForModel = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < resolvedForModelMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, input: { id: string; model: string | null; resolvedModel: string | null }) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model)
    VALUES (?, 'existing', '/tmp', ?, 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', ?)`).run(input.id, input.model, `h-${input.id}`, `m-${input.id}`, input.resolvedModel);
};

const upgradedDatabase = (sessions: { id: string; model: string | null; resolvedModel: string | null }[]) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeResolvedForModel);
  for (const session of sessions) insertSession(db, session);
  applyMigrations(db);
  return db;
};

describe('the resolved-for-model migration upgrading a database that knows the resolved model column', () => {
  it('records the requested model of every session that already holds a resolved model, the default model included', () => {
    const db = upgradedDatabase([
      { id: 'alias', model: 'opus', resolvedModel: 'claude-opus-5-5' },
      { id: 'default', model: null, resolvedModel: 'claude-default-5-5' },
    ]);

    const rows = db.prepare('SELECT id, model, resolved_model, resolved_for_model FROM sessions ORDER BY id').all();

    expect(rows).toEqual([
      { id: 'alias', model: 'opus', resolved_model: 'claude-opus-5-5', resolved_for_model: 'opus' },
      { id: 'default', model: null, resolved_model: 'claude-default-5-5', resolved_for_model: null },
    ]);
  });

  it('leaves a session without a resolved model untouched, with nothing resolved for its model either', () => {
    const db = upgradedDatabase([{ id: 'unrecorded', model: 'opus', resolvedModel: null }]);

    const rows = db.prepare('SELECT id, model, resolved_model, resolved_for_model FROM sessions').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(rows).toEqual([{ id: 'unrecorded', model: 'opus', resolved_model: null, resolved_for_model: null }]);
    expect(foreignKeyViolations).toEqual([]);
  });
});
