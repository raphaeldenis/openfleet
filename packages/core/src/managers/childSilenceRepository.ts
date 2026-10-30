import type { DatabaseSync } from 'node:sqlite';

export interface StoredSilenceCheck {
  childId: string;
  managerId: string;
  armedAt: string;
  dueAt: string;
}

/** The silence checks that survive a daemon restart: one row per child, replaced by each new message to it. */
export class ChildSilenceRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(check: StoredSilenceCheck): void {
    this.db.prepare('INSERT OR REPLACE INTO child_silence_checks (child_id, manager_id, armed_at, due_at) VALUES (?, ?, ?, ?)')
      .run(check.childId, check.managerId, check.armedAt, check.dueAt);
  }

  remove(childId: string): void {
    this.db.prepare('DELETE FROM child_silence_checks WHERE child_id = ?').run(childId);
  }

  list(): StoredSilenceCheck[] {
    const rows = this.db.prepare('SELECT child_id, manager_id, armed_at, due_at FROM child_silence_checks').all() as
      { child_id: string; manager_id: string; armed_at: string; due_at: string }[];
    return rows.map((row) => ({ childId: row.child_id, managerId: row.manager_id, armedAt: row.armed_at, dueAt: row.due_at }));
  }
}
