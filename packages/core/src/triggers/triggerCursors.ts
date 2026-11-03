import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';

interface CursorRow { trigger_id: string; cursor_json: string }

/** The `kind` of the cursor of a table trigger: a position in a change history, kept for as long as the trigger lives. */
export const TABLE_CURSOR_KIND = 'table';

const isTableCursor = (value: unknown): boolean => (value as { kind?: unknown } | null)?.kind === TABLE_CURSOR_KIND;

/** What a source remembers about a trigger between two boots, as JSON, one row per trigger. */
export class TriggerCursors {
  constructor(private readonly db: DatabaseSync) {}

  /** Replaces the cursor of a trigger. */
  save(triggerId: string, value: unknown): void {
    this.db.prepare('INSERT INTO trigger_cursors (trigger_id, cursor_json) VALUES (?, ?) ON CONFLICT (trigger_id) DO UPDATE SET cursor_json = excluded.cursor_json')
      .run(triggerId, JSON.stringify(value));
  }

  /** The cursor of a trigger as it was saved, left in place; undefined when there is none or it is not valid JSON. */
  read(triggerId: string): unknown {
    const row = this.db.prepare('SELECT trigger_id, cursor_json FROM trigger_cursors WHERE trigger_id = ?').get(triggerId) as CursorRow | undefined;
    return row === undefined ? undefined : this.parse(row)?.parsed;
  }

  /** Reads every cursor of a wait and forgets the ones it could parse: a source writes its cursors again when it stops. The cursor of a table trigger stays. A corrupted cursor stays, and the others are still returned. */
  takeAll(): { triggerId: string; value: unknown }[] {
    const rows = this.db.prepare('SELECT trigger_id, cursor_json FROM trigger_cursors').all() as unknown as CursorRow[];
    const parsedCursors = rows.flatMap((row) => {
      const value = this.parse(row);
      return value === undefined || isTableCursor(value.parsed) ? [] : [{ triggerId: row.trigger_id, value: value.parsed }];
    });
    const forget = this.db.prepare('DELETE FROM trigger_cursors WHERE trigger_id = ?');
    for (const { triggerId } of parsedCursors) forget.run(triggerId);
    return parsedCursors;
  }

  private parse(row: CursorRow): { parsed: unknown } | undefined {
    try {
      return { parsed: JSON.parse(row.cursor_json) as unknown };
    } catch (error) {
      log('warn', `the cursor of trigger ${row.trigger_id} is not valid JSON and was left in place`, error);
      return undefined;
    }
  }
}
