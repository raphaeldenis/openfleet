import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const deniedCommandsMigrationFileName = '030_denied_commands.sql';

const migrationsBeforeDeniedCommands = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < deniedCommandsMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
    VALUES (?, 'Worker', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0')`).run(id, `h-${id}`, `m-${id}`);

const insertDenial = (db: DatabaseSync, overrides: Record<string, string | null> = {}) => {
  const row = {
    id: 'd1', session_id: 'worker', manager_id: 'lead', role: 'DEV', profile: 'dev', harness: 'fake', rule_id: 'no-forced-recursive-rm',
    decision_source: 'policy', outcome: 'denied', tool_name: 'Bash', command_excerpt: 'rm -rf x', alternative: 'rm -r x', actor: 'session', created_at: 't1',
    ...overrides,
  };
  db.prepare(`INSERT INTO denied_commands (id, session_id, manager_id, role, profile, harness, rule_id, decision_source, outcome, tool_name, command_excerpt, alternative, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.session_id, row.manager_id, row.role, row.profile, row.harness, row.rule_id, row.decision_source, row.outcome, row.tool_name, row.command_excerpt, row.alternative, row.actor, row.created_at);
};

const upgradedDatabaseWithOneSession = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeDeniedCommands);
  insertSession(db, 'worker');
  applyMigrations(db);
  return db;
};

describe('the denied commands migration upgrading a database that predates it', () => {
  it('keeps the existing session and starts with an empty journal', () => {
    const db = upgradedDatabaseWithOneSession();

    expect(db.prepare("SELECT name FROM sessions WHERE id = 'worker'").get()).toEqual({ name: 'Worker' });
    expect(db.prepare('SELECT count(*) AS n FROM denied_commands').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps a denial after the session that suffered it is deleted', () => {
    const db = upgradedDatabaseWithOneSession();
    insertDenial(db);

    db.prepare("DELETE FROM sessions WHERE id = 'worker'").run();

    expect(db.prepare('SELECT count(*) AS n FROM denied_commands').get()).toEqual({ n: 1 });
  });

  it.each([
    ['a decision source nobody knows', { decision_source: 'guess' }],
    ['an outcome nobody knows', { outcome: 'maybe' }],
    ['an actor nobody knows', { actor: 'robot' }],
    ['an excerpt longer than 200 characters', { command_excerpt: 'x'.repeat(201) }],
  ])('refuses %s', (_label, overrides) => {
    const db = upgradedDatabaseWithOneSession();

    expect(() => insertDenial(db, overrides)).toThrow(/CHECK/);
  });

  it('indexes the denials of a manager by date', () => {
    const db = upgradedDatabaseWithOneSession();

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'denied_commands'").all() as { name: string }[];

    expect(indexes.map((index) => index.name)).toContain('denied_commands_by_manager');
  });
});
