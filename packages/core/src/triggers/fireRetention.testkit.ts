import type { DatabaseSync } from 'node:sqlite';
import type { TriggerLedgerState } from '@openfleet/shared';

export const NOW_ISO = '2026-11-04T10:00:00.000Z';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const isoDaysBefore = (days: number, nowIso = NOW_ISO) => new Date(Date.parse(nowIso) - days * MILLISECONDS_PER_DAY).toISOString();

/** A fire row as a daemon left it: its state and the instant it ended (`null` for a fire that has not ended). */
export interface FireToLeave { ledgerState: TriggerLedgerState; settledAt: string | null }

/** Leaves one fire row per entry in the ledger of a trigger, the way a daemon that ran for months would have written them. */
export function leaveFires(db: DatabaseSync, triggerId: string, fires: Iterable<FireToLeave>): string[] {
  const insert = db.prepare(
    `INSERT INTO trigger_fires (id, trigger_id, dedup_key, ledger_state, fired_at, settled_at, event_json) VALUES (?, ?, ?, ?, ?, ?, '{"session":{"name":"Left"}}')`,
  );
  const ids: string[] = [];
  db.exec('BEGIN');
  for (const fire of fires) {
    const id = `left-${ids.length}`;
    insert.run(id, triggerId, `key-${id}`, fire.ledgerState, fire.settledAt ?? NOW_ISO, fire.settledAt);
    ids.push(id);
  }
  db.exec('COMMIT');
  return ids;
}

/** A project and a trigger on a bare database, enough for fire rows to reference. */
export function leaveTrigger(db: DatabaseSync, triggerId = 'trigger-retention'): string {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project-retention', 'Retention', 'now')").run();
  db.prepare(
    `INSERT INTO triggers (id, project_id, title, when_json, conditions_json, run_json, policy_json, created_at, updated_at)
     VALUES (?, 'project-retention', 'Retention', '{}', '[]', '{}', '{}', 'now', 'now')`,
  ).run(triggerId);
  return triggerId;
}

export const remainingFireIds = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT id FROM trigger_fires ORDER BY rowid').all() as { id: string }[]).map((row) => row.id);

/** The fires whose event the ledger has forgotten: the witness rows that keep a dedup key and a settling date. */
export const forgottenFireIds = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT id FROM trigger_fires WHERE event_json = '{}' ORDER BY rowid").all() as { id: string }[]).map((row) => row.id);

export const fireCount =(db: DatabaseSync): number => Number((db.prepare('SELECT COUNT(*) AS total FROM trigger_fires').get() as { total: number }).total);
