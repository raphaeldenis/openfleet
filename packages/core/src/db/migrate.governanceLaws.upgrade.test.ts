import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const governanceLawsMigrationFileName = '036_governance_laws.sql';

const migrationFiles = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const sourcesOf = (fileNames: string[]) => fileNames.map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));
const migrationsBeforeGovernanceLaws = sourcesOf(migrationFiles.filter((fileName) => fileName < governanceLawsMigrationFileName));
const governanceLawsMigrationSql = readFileSync(new URL(governanceLawsMigrationFileName, migrationsDirectory), 'utf8');
const backfillStatements = governanceLawsMigrationSql.slice(governanceLawsMigrationSql.indexOf('INSERT INTO laws'));

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

interface ProposalSeed { id: string; manager_id?: string; kind?: string; status?: string; payload_json?: string; created_at?: string; decided_at?: string | null; denial_reason?: string | null }

const insertProposal = (db: DatabaseSync, seed: ProposalSeed) => {
  const status = seed.status ?? 'approved';
  const row = {
    manager_id: 'lead', kind: 'law', payload_json: '{"text":"be kind"}', created_at: '2026-10-01T08:00:00.000Z',
    decided_at: status === 'pending' ? null : '2026-10-01T09:00:00.000Z', denial_reason: status === 'denied' ? 'no' : null, ...seed, status,
  };
  db.prepare('INSERT INTO governance_proposals (id, manager_id, kind, status, incident, payload_json, denial_reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.manager_id, row.kind, row.status, 'it broke', row.payload_json, row.denial_reason, row.created_at, row.decided_at);
};

const databaseBeforeGovernanceLaws = (seed: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeGovernanceLaws);
  insertManager(db, 'lead');
  insertManager(db, 'other');
  seed(db);
  return db;
};

const upgraded = (seed: (db: DatabaseSync) => void = () => undefined) => {
  const db = databaseBeforeGovernanceLaws(seed);
  applyMigrations(db);
  return db;
};

const insertLaw = (db: DatabaseSync, overrides: Record<string, string | number | null> = {}) => {
  const row = {
    id: 'l1', manager_id: 'lead', text: 'be kind', status: 'active', revision: 1, created_at: 't1', updated_at: 't1', withdrawn_at: null,
    approved_by: 'admin', updated_by: null, withdrawn_by: null, source_kind: 'proposal', source_key: null, source_created_at: null, proposal_id: null, ...overrides,
  };
  db.prepare(`INSERT INTO laws (id, manager_id, text, status, revision, created_at, updated_at, withdrawn_at, approved_by, updated_by, withdrawn_by, source_kind, source_key, source_created_at, proposal_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.manager_id, row.text, row.status, row.revision, row.created_at, row.updated_at, row.withdrawn_at, row.approved_by, row.updated_by, row.withdrawn_by, row.source_kind, row.source_key, row.source_created_at, row.proposal_id);
};

const allLaws = (db: DatabaseSync) => db.prepare('SELECT * FROM laws ORDER BY proposal_id').all() as Record<string, string | number | null>[];

describe('the governance laws migration upgrading a database that predates it', () => {
  it('turns every retained approved law proposal into an active legacy law, without inventing an author', () => {
    const db = upgraded((old) => {
      insertProposal(old, { id: 'p-lead-1', payload_json: '{"text":"Never force-push"}', created_at: '2026-10-01T08:00:00.000Z', decided_at: '2026-10-01T09:00:00.000Z' });
      insertProposal(old, { id: 'p-other-1', manager_id: 'other', payload_json: '{"text":"Ask before deleting"}' });
    });

    expect(allLaws(db)).toEqual([
      expect.objectContaining({
        id: expect.any(String), manager_id: 'lead', text: 'Never force-push', status: 'active', revision: 1, source_kind: 'legacy', source_key: expect.any(String),
        created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z', source_created_at: '2026-10-01T08:00:00.000Z',
        approved_by: null, updated_by: null, withdrawn_at: null, withdrawn_by: null, proposal_id: 'p-lead-1',
      }),
      expect.objectContaining({ manager_id: 'other', text: 'Ask before deleting', proposal_id: 'p-other-1' }),
    ]);
  });

  it('leaves the proposals as they were and keeps the managers', () => {
    const db = upgraded((old) => insertProposal(old, { id: 'p1' }));

    expect(db.prepare('SELECT id, status, payload_json FROM governance_proposals').all()).toEqual([{ id: 'p1', status: 'approved', payload_json: '{"text":"be kind"}' }]);
    expect(db.prepare('SELECT count(*) AS n FROM managers').get()).toEqual({ n: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('ignores what is not an approved law: pending, denied and withdrawn laws, and approved permissions and accesses', () => {
    const db = upgraded((old) => {
      insertProposal(old, { id: 'pending', status: 'pending' });
      insertProposal(old, { id: 'denied', status: 'denied' });
      insertProposal(old, { id: 'withdrawn', status: 'withdrawn' });
      insertProposal(old, { id: 'permission', kind: 'permission', payload_json: '{"action":"a","scope":"s","condition":"c","exclusions":"e"}' });
      insertProposal(old, { id: 'access', kind: 'resourceAccess', payload_json: '{"resourceType":"note","resourceId":"n","access":"read","role":"r"}' });
    });

    expect(allLaws(db)).toEqual([]);
  });

  it('skips an approved law whose stored text cannot be a law (no text, blank, too long) instead of failing the upgrade', () => {
    const db = upgraded((old) => {
      insertProposal(old, { id: 'no-text', payload_json: '{"body":"x"}' });
      insertProposal(old, { id: 'blank', payload_json: '{"text":"   "}' });
      insertProposal(old, { id: 'too-long', payload_json: JSON.stringify({ text: 'x'.repeat(2001) }) });
      insertProposal(old, { id: 'not-text', payload_json: '{"text":42}' });
      insertProposal(old, { id: 'fine', payload_json: '{"text":"kept"}' });
    });

    expect(allLaws(db).map((law) => law.proposal_id)).toEqual(['fine']);
  });

  it('backfills more than 500 proposals', () => {
    const proposalCount = 1200;
    const db = upgraded((old) => { for (let index = 0; index < proposalCount; index += 1) insertProposal(old, { id: `p-${String(index).padStart(5, '0')}`, payload_json: JSON.stringify({ text: `law ${index}` }) }); });

    expect(db.prepare('SELECT count(*) AS n FROM laws').get()).toEqual({ n: proposalCount });
  });

  it('creates no duplicate when the backfill runs again', () => {
    const db = upgraded((old) => { insertProposal(old, { id: 'p1' }); insertProposal(old, { id: 'p2', manager_id: 'other' }); });
    const lawsBefore = allLaws(db);

    db.exec(backfillStatements);

    expect(allLaws(db)).toEqual(lawsBefore);
  });

  it('is applied once: a database already at 036 is not backfilled again at the next boot', () => {
    const db = upgraded((old) => insertProposal(old, { id: 'p1' }));
    db.prepare('DELETE FROM laws').run();

    applyMigrations(db);

    expect(allLaws(db)).toEqual([]);
  });
});

describe('the laws table', () => {
  const dbWithTwoManagers = () => upgraded();

  it('refuses a blank law and a law longer than 2000 characters', () => {
    const db = dbWithTwoManagers();

    expect(() => insertLaw(db, { text: '   ' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { text: 'x'.repeat(2001) })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { text: 'x'.repeat(2000) })).not.toThrow();
  });

  it('refuses a status other than active or withdrawn and a revision below one', () => {
    const db = dbWithTwoManagers();

    expect(() => insertLaw(db, { status: 'pending' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { revision: 0 })).toThrow(/CHECK/);
  });

  it('refuses a withdrawn law without its date or its author, and an active law that carries them', () => {
    const db = dbWithTwoManagers();

    expect(() => insertLaw(db, { status: 'withdrawn', withdrawn_at: 't2', withdrawn_by: null })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { status: 'withdrawn', withdrawn_at: null, withdrawn_by: 'admin' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { status: 'active', withdrawn_at: 't2', withdrawn_by: 'admin' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { status: 'withdrawn', withdrawn_at: 't2', withdrawn_by: 'admin' })).not.toThrow();
  });

  it('refuses a law born from a proposal without an approver, but accepts a legacy one without', () => {
    const db = dbWithTwoManagers();

    expect(() => insertLaw(db, { id: 'l1', approved_by: null })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { id: 'l2', approved_by: '   ' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { id: 'l3', approved_by: null, source_kind: 'legacy', source_key: 'legacy-proposal:x' })).not.toThrow();
  });

  it('refuses an unknown provenance and a source key on a law born from a proposal', () => {
    const db = dbWithTwoManagers();

    expect(() => insertLaw(db, { source_kind: 'guess' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { source_kind: 'proposal', source_key: 'k' })).toThrow(/CHECK/);
    expect(() => insertLaw(db, { source_kind: 'import', source_key: null })).toThrow(/CHECK/);
  });

  it('keeps a single law per source key and per proposal', () => {
    const db = dbWithTwoManagers();
    insertProposal(db, { id: 'p1' });
    insertLaw(db, { id: 'l1', source_kind: 'import', source_key: 'k1', proposal_id: 'p1' });

    expect(() => insertLaw(db, { id: 'l2', source_kind: 'import', source_key: 'k1' })).toThrow(/UNIQUE/);
    expect(() => insertLaw(db, { id: 'l3', source_kind: 'import', source_key: 'k2', proposal_id: 'p1' })).toThrow(/UNIQUE/);
  });

  it('keeps the law when its proposal is evicted, and removes it with its manager', () => {
    const db = dbWithTwoManagers();
    insertProposal(db, { id: 'p1' });
    insertLaw(db, { id: 'l1', proposal_id: 'p1' });

    db.prepare("DELETE FROM governance_proposals WHERE id = 'p1'").run();
    const lawAfterEviction = db.prepare("SELECT proposal_id FROM laws WHERE id = 'l1'").get();
    db.prepare("DELETE FROM managers WHERE session_id = 'lead'").run();

    expect(lawAfterEviction).toEqual({ proposal_id: null });
    expect(db.prepare('SELECT count(*) AS n FROM laws').get()).toEqual({ n: 0 });
  });

  it('indexes the laws by manager, status and id', () => {
    const db = dbWithTwoManagers();

    const indexedColumns = (db.prepare("SELECT name FROM pragma_index_info('laws_by_manager') ORDER BY seqno").all() as { name: string }[]).map((column) => column.name);

    expect(indexedColumns).toEqual(['manager_id', 'status', 'id']);
  });

  it('is a STRICT table', () => {
    const db = dbWithTwoManagers();

    expect(() => insertLaw(db, { revision: 'one' })).toThrow();
  });
});
