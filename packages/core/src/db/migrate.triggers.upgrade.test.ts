import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const openMigratedDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  return db;
};

const insertTrigger = (db: DatabaseSync, id = 't1') =>
  db.prepare("INSERT INTO triggers (id, project_id, title, when_json, conditions_json, run_json, policy_json, created_at, updated_at) VALUES (?, 'p1', 'T', '{}', '[]', '{}', '{}', 'n', 'n')").run(id);

const insertFire = (db: DatabaseSync, overrides: { dedupKey?: string; ledgerState?: string } = {}) =>
  db.prepare("INSERT INTO trigger_fires (id, trigger_id, dedup_key, ledger_state, fired_at) VALUES (?, 't1', ?, ?, 'n')")
    .run(`fire-${Math.random()}`, overrides.dedupKey ?? 'k1', overrides.ledgerState ?? 'accepted');

describe('the triggers migration', () => {
  it('creates the three tables on an empty database and starts a trigger unarmed at revision 1', () => {
    const db = openMigratedDatabase();

    insertTrigger(db);

    expect(db.prepare('SELECT content_rev, armed_at, approved_rev, approved_graph_digest FROM triggers').get()).toEqual({ content_rev: 1, armed_at: null, approved_rev: null, approved_graph_digest: null });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('triggers', 'trigger_fires', 'trigger_cursors') ORDER BY name").all()).toEqual([{ name: 'trigger_cursors' }, { name: 'trigger_fires' }, { name: 'triggers' }]);
  });

  it('refuses a second fire with the same dedup key for one trigger, and allows it for another trigger', () => {
    const db = openMigratedDatabase();
    insertTrigger(db, 't1');
    insertTrigger(db, 't2');
    insertFire(db, { dedupKey: 'same' });

    expect(() => insertFire(db, { dedupKey: 'same' })).toThrow(/UNIQUE constraint/);
    db.prepare("INSERT INTO trigger_fires (id, trigger_id, dedup_key, ledger_state, fired_at) VALUES ('other', 't2', 'same', 'accepted', 'n')").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM trigger_fires').get()).toEqual({ n: 2 });
  });

  it('refuses a ledger state outside accepted, attempted, completed, cancelled and needs_review', () => {
    const db = openMigratedDatabase();
    insertTrigger(db);

    expect(() => insertFire(db, { ledgerState: 'maybe' })).toThrow(/CHECK constraint/);
  });

  it('refuses an armed trigger that lacks its approved revision or digest, and an approval without arming', () => {
    const db = openMigratedDatabase();
    insertTrigger(db);

    expect(() => db.prepare("UPDATE triggers SET armed_at = 'n' WHERE id = 't1'").run()).toThrow(/CHECK constraint/);
    expect(() => db.prepare("UPDATE triggers SET approved_rev = 1, approved_graph_digest = 'd' WHERE id = 't1'").run()).toThrow(/CHECK constraint/);
  });

  it('removes the fires and the cursor of a deleted trigger', () => {
    const db = openMigratedDatabase();
    insertTrigger(db);
    insertFire(db);
    db.prepare("INSERT INTO trigger_cursors (trigger_id, cursor_json) VALUES ('t1', '{}')").run();

    db.prepare("DELETE FROM triggers WHERE id = 't1'").run();

    expect(db.prepare('SELECT (SELECT COUNT(*) FROM trigger_fires) AS fires, (SELECT COUNT(*) FROM trigger_cursors) AS cursors').get()).toEqual({ fires: 0, cursors: 0 });
  });

  it('keeps the event of a fire, the reason it ended and its depth in a chain, with no reason and a depth of 1 by default', () => {
    const db = openMigratedDatabase();
    insertTrigger(db);
    insertFire(db);

    expect(db.prepare('SELECT event_json, settle_reason, chain_depth FROM trigger_fires').get()).toEqual({ event_json: '{}', settle_reason: null, chain_depth: 1 });
  });

  it('ships down migrations outside the migrations folder that remove the added columns, then the three tables', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('065_trigger_fire_events.down.sql', migrationsDownDirectory), 'utf8'));
    const columnsAfterFirstDown = (db.prepare("SELECT name FROM pragma_table_info('trigger_fires')").all() as { name: string }[]).map((column) => column.name);
    db.exec(readFileSync(new URL('064_triggers.down.sql', migrationsDownDirectory), 'utf8'));

    expect(columnsAfterFirstDown).not.toContain('event_json');
    expect(columnsAfterFirstDown).not.toContain('settle_reason');
    expect(columnsAfterFirstDown).not.toContain('chain_depth');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'trigger%'").all()).toEqual([]);
  });
});
