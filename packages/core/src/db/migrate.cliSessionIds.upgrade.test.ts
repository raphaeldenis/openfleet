import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const cliSessionIdsMigrationFileName = '013_session_cli_ids.sql';

const migrationsBeforeCliSessionIds = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < cliSessionIdsMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string, cliSessionId: string | null) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model, cli_session_id)
    VALUES (?, 'existing', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus', ?)`).run(id, `h-${id}`, `m-${id}`, cliSessionId);
};

describe('the adopted CLI session ids migration upgrading a database that predates it', () => {
  it('leaves every session intact and reserves the conversation each already resumes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeCliSessionIds);
    insertSession(db, 'cleared', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    insertSession(db, 'never-cleared', null);
    const rowsBeforeUpgrade = db.prepare('SELECT * FROM sessions ORDER BY id').all();

    applyMigrations(db);

    expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(rowsBeforeUpgrade);
    expect(db.prepare('SELECT cli_session_id, session_id FROM session_cli_ids').all()).toEqual([
      { cli_session_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', session_id: 'cleared' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
