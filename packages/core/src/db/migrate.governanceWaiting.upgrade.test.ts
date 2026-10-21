import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const waitingMigrationFileName = '037_governance_waiting_proposals.sql';

const migrationFiles = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const sourcesOf = (fileNames: string[]) => fileNames.map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));
const migrationsBeforeWaiting = sourcesOf(migrationFiles.filter((fileName) => fileName < waitingMigrationFileName));

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

const insertApprovedLawProposal = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO governance_proposals (id, manager_id, kind, status, incident, payload_json, created_at, decided_at)
    VALUES (?, 'lead', 'law', 'approved', 'it broke', '{"text":"be kind"}', 't1', 't2')`).run(id);
};

const insertWaiting = (db: DatabaseSync, overrides: Record<string, string> = {}) => {
  const row = { id: 'w1', manager_id: 'lead', kind: 'law', incident: 'it broke', payload_json: '{"text":"wait"}', created_at: 't3', ...overrides };
  db.prepare('INSERT INTO governance_waiting_proposals (id, manager_id, kind, incident, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, row.manager_id, row.kind, row.incident, row.payload_json, row.created_at);
};

const databaseBeforeWaiting = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeWaiting);
  insertManager(db, 'lead');
  insertApprovedLawProposal(db, 'p1');
  db.prepare(`INSERT INTO laws (id, manager_id, text, status, revision, created_at, updated_at, approved_by, source_kind, proposal_id)
    VALUES ('l1', 'lead', 'be kind', 'active', 1, 't2', 't2', 'admin', 'proposal', 'p1')`).run();
  db.prepare("INSERT INTO governance_resource_grants (id, manager_id, resource_type, resource_id, role, access, proposal_id, granted_at) VALUES ('g1', 'lead', 'note', 'n1', 'ref', 'read', 'p1', 't2')").run();
  return db;
};

const upgraded = () => {
  const db = databaseBeforeWaiting();
  applyMigrations(db);
  return db;
};

describe('the waiting proposals migration upgrading a database that predates it', () => {
  it('loses nothing: the proposals, the laws and the grants keep their proposal_id', () => {
    const db = databaseBeforeWaiting();
    const lawsBefore = db.prepare('SELECT * FROM laws ORDER BY id').all();
    const proposalsBefore = db.prepare('SELECT * FROM governance_proposals ORDER BY id').all();

    applyMigrations(db);

    expect(db.prepare('SELECT * FROM governance_proposals ORDER BY id').all()).toEqual(proposalsBefore);
    expect(db.prepare('SELECT * FROM laws ORDER BY id').all()).toEqual(lawsBefore);
    expect(db.prepare('SELECT proposal_id FROM laws').all()).toEqual([{ proposal_id: 'p1' }]);
    expect(db.prepare('SELECT proposal_id FROM governance_resource_grants').all()).toEqual([{ proposal_id: 'p1' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('starts with an empty waiting list', () => {
    expect(upgraded().prepare('SELECT count(*) AS n FROM governance_waiting_proposals').get()).toEqual({ n: 0 });
  });

  it('is applied once: a second boot changes nothing', () => {
    const db = upgraded();
    insertWaiting(db);

    applyMigrations(db);

    expect(db.prepare('SELECT count(*) AS n FROM governance_waiting_proposals').get()).toEqual({ n: 1 });
  });
});

describe('the waiting proposals table', () => {
  it('refuses an unknown kind, a blank incident and a payload that is not a JSON object', () => {
    const db = upgraded();

    expect(() => insertWaiting(db, { kind: 'guess' })).toThrow(/CHECK/);
    expect(() => insertWaiting(db, { incident: '   ' })).toThrow(/CHECK/);
    expect(() => insertWaiting(db, { payload_json: '[1]' })).toThrow(/CHECK/);
    expect(() => insertWaiting(db, { payload_json: 'nope' })).toThrow(/CHECK/);
  });

  it('refuses a manager that does not exist and is emptied with its manager', () => {
    const db = upgraded();

    expect(() => insertWaiting(db, { manager_id: 'ghost' })).toThrow(/FOREIGN KEY/);
    insertWaiting(db);
    db.prepare("DELETE FROM managers WHERE session_id = 'lead'").run();

    expect(db.prepare('SELECT count(*) AS n FROM governance_waiting_proposals').get()).toEqual({ n: 0 });
  });

  it('indexes the waiting proposals by manager then filing order', () => {
    const db = upgraded();

    const indexedColumns = (db.prepare("SELECT name FROM pragma_index_info('governance_waiting_by_manager') ORDER BY seqno").all() as { name: string | null }[]).map((column) => column.name);

    expect(indexedColumns.slice(0, 2)).toEqual(['manager_id', 'created_at']);
  });

  it('is a STRICT table', () => {
    const db = upgraded();

    expect(() => db.prepare("INSERT INTO governance_waiting_proposals (id, manager_id, kind, incident, payload_json, created_at) VALUES (x'00', 'lead', 'law', 'x', '{}', 't')").run()).toThrow();
  });
});
