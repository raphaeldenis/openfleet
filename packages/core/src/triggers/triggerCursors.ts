import type { DatabaseSync } from 'node:sqlite';

/** What a source remembers about a trigger between two boots, as JSON, one row per trigger. */
export class TriggerCursors {
  constructor(private readonly db: DatabaseSync) {}

  /** Replaces the cursor of a trigger. */
  save(triggerId: string, value: unknown): void {
    this.db.prepare('INSERT INTO trigger_cursors (trigger_id, cursor_json) VALUES (?, ?) ON CONFLICT (trigger_id) DO UPDATE SET cursor_json = excluded.cursor_json')
      .run(triggerId, JSON.stringify(value));
  }

  /** Reads every cursor and forgets them: a source writes its cursors again when it stops. */
  takeAll(): { triggerId: string; value: unknown }[] {
    const rows = this.db.prepare('SELECT trigger_id, cursor_json FROM trigger_cursors').all() as { trigger_id: string; cursor_json: string }[];
    this.db.prepare('DELETE FROM trigger_cursors').run();
    return rows.map((row) => ({ triggerId: row.trigger_id, value: JSON.parse(row.cursor_json) as unknown }));
  }
}
