import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const cliSessionIdMigrationFileName = '012_session_cli_session_id.sql';

const migrationsBeforeCliSessionId = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < cliSessionIdMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'existing', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
};

describe('the CLI session id migration upgrading a database that predates it', () => {
  it('leaves every existing session intact and gives it no CLI session id, so it keeps resuming its launch conversation', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeCliSessionId);
    insertSession(db, 'first');
    insertSession(db, 'second');
    const rowsBeforeUpgrade = db.prepare('SELECT * FROM sessions ORDER BY id').all();

    applyMigrations(db);

    const rowsAfterUpgrade = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    expect(rowsAfterUpgrade).toEqual(rowsBeforeUpgrade.map((row) => ({ ...row, cli_session_id: null, prompted: 0, context_notice_tokens: null, close_reason: null, seeded_prompt: null })));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
