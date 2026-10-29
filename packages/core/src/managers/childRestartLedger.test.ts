import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { ChildRestartLedger } from './childRestartLedger.js';

let db: DatabaseSync;
let ledger: ChildRestartLedger;

const insertSession = (id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Child', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  insertSession('child');
  insertSession('other');
  ledger = new ChildRestartLedger(db);
});

describe('the restarts of a child counted in a sliding window', () => {
  it('counts only the restarts of that child recorded at or after the start of the window', () => {
    ledger.record('child', '2026-10-29T10:00:00.000Z');
    ledger.record('child', '2026-10-29T10:20:00.000Z');
    ledger.record('other', '2026-10-29T10:25:00.000Z');

    const restartsInWindow = ledger.countSince('child', '2026-10-29T10:10:00.000Z');

    expect(restartsInWindow).toBe(1);
  });

  it('counts a restart recorded exactly at the start of the window', () => {
    ledger.record('child', '2026-10-29T10:00:00.000Z');

    expect(ledger.countSince('child', '2026-10-29T10:00:00.000Z')).toBe(1);
  });
});
