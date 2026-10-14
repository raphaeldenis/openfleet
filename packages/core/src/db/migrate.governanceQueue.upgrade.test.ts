import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagerRepository } from '../managers/managerRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const governanceQueueMigrationFileName = '029_governance_queue.sql';

const migrationsBeforeGovernanceQueue = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < governanceQueueMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

const insertProposal = (db: DatabaseSync, overrides: Record<string, string | null> = {}) => {
  const row = { id: 'p1', manager_id: 'lead', kind: 'law', status: 'pending', incident: 'it broke', payload_json: '{"text":"be kind"}', denial_reason: null, created_at: 't1', decided_at: null, ...overrides };
  db.prepare('INSERT INTO governance_proposals (id, manager_id, kind, status, incident, payload_json, denial_reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.manager_id, row.kind, row.status, row.incident, row.payload_json, row.denial_reason, row.created_at, row.decided_at);
};

const upgradedDatabaseWithOneManager = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeGovernanceQueue);
  insertManager(db, 'lead');
  applyMigrations(db);
  return db;
};

describe('the governance queue migration upgrading a database that predates it', () => {
  it('keeps the existing manager as it was and starts its evicted-denials counter at zero', () => {
    const db = upgradedDatabaseWithOneManager();

    const evicted = db.prepare("SELECT governance_evicted_denials AS n FROM managers WHERE session_id = 'lead'").get() as { n: number };

    expect(evicted.n).toBe(0);
    expect(new ManagerRepository(db).get('lead')).toMatchObject({ sessionId: 'lead', pulseSeconds: 1800, childrenCap: 3, missionText: 'Ship it' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('refuses a proposal whose incident is blank', () => {
    const db = upgradedDatabaseWithOneManager();

    expect(() => insertProposal(db, { incident: '   ' })).toThrow(/CHECK/);
  });

  it('refuses a payload that is not JSON', () => {
    const db = upgradedDatabaseWithOneManager();

    expect(() => insertProposal(db, { payload_json: '{not json' })).toThrow(/CHECK/);
  });

  it.each(['[]', '"text"', '42', 'null'])('refuses a payload that is JSON but not an object (%s)', (payloadJson) => {
    const db = upgradedDatabaseWithOneManager();

    expect(() => insertProposal(db, { payload_json: payloadJson })).toThrow(/CHECK/);
  });

  it('refuses a denied proposal without a reason and a pending proposal that carries a decision date', () => {
    const db = upgradedDatabaseWithOneManager();

    expect(() => insertProposal(db, { status: 'denied', decided_at: 't2' })).toThrow(/CHECK/);
    expect(() => insertProposal(db, { status: 'pending', decided_at: 't2' })).toThrow(/CHECK/);
  });

  it('removes the proposals and grants of a manager deleted with its session', () => {
    const db = upgradedDatabaseWithOneManager();
    insertProposal(db);
    db.prepare("INSERT INTO governance_resource_grants (id, manager_id, resource_type, resource_id, role, access, proposal_id, granted_at) VALUES ('g1', 'lead', 'note', 'n1', 'reader', 'read', 'p1', 't2')").run();

    db.prepare("DELETE FROM managers WHERE session_id = 'lead'").run();

    expect(db.prepare('SELECT count(*) AS n FROM governance_proposals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM governance_resource_grants').get()).toEqual({ n: 0 });
  });

  it('keeps a single grant per manager and resource', () => {
    const db = upgradedDatabaseWithOneManager();
    const insertGrant = (id: string) => db.prepare("INSERT INTO governance_resource_grants (id, manager_id, resource_type, resource_id, role, access, granted_at) VALUES (?, 'lead', 'note', 'n1', 'reader', 'read', 't2')").run(id);
    insertGrant('g1');

    expect(() => insertGrant('g2')).toThrow(/UNIQUE/);
  });
});
