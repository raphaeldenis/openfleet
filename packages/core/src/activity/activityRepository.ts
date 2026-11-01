import type { DatabaseSync } from 'node:sqlite';
import type { ActivityPage, ActivityRow } from '@openfleet/shared';

/** A row ready to store: its text is already masked and bounded. */
export type ActivityRowToStore = Omit<ActivityRow, 'id'>;

export interface ActivityQuery {
  actorKind?: ActivityRow['actorKind'];
  sessionId?: string;
  managerId?: string;
  entityKind?: string;
  action?: string;
  outcome?: ActivityRow['outcome'];
  /** Rows at or after this instant (ISO 8601). */
  since?: string;
  /** Rows at or before this instant (ISO 8601). */
  until?: string;
  limit: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
}

interface StoredActivityRow {
  id: number;
  at: string;
  actor_kind: ActivityRow['actorKind'];
  actor_label: string;
  session_id: string | null;
  manager_id: string | null;
  source: ActivityRow['source'];
  action: string;
  entity_kind: string | null;
  entity_id: string | null;
  entity_label: string | null;
  outcome: ActivityRow['outcome'];
  duration_ms: number | null;
  detail: string | null;
  args_excerpt: string | null;
  result_excerpt: string | null;
}

const presentWhenStored = <Key extends string, Value extends string | number>(key: Key, value: Value | null) =>
  (value === null ? {} : { [key]: value }) as { [K in Key]?: Value };

function activityRowOf(row: StoredActivityRow): ActivityRow {
  return {
    id: row.id,
    at: row.at,
    actorKind: row.actor_kind,
    actorLabel: row.actor_label,
    ...presentWhenStored('sessionId', row.session_id),
    ...presentWhenStored('managerId', row.manager_id),
    source: row.source,
    action: row.action,
    ...presentWhenStored('entityKind', row.entity_kind),
    ...presentWhenStored('entityId', row.entity_id),
    ...presentWhenStored('entityLabel', row.entity_label),
    outcome: row.outcome,
    ...presentWhenStored('durationMs', row.duration_ms),
    ...presentWhenStored('detail', row.detail),
    ...presentWhenStored('argsExcerpt', row.args_excerpt),
    ...presentWhenStored('resultExcerpt', row.result_excerpt),
  };
}

/** The append-only activity log: rows are inserted and listed newest first; only retention removes them. */
export class ActivityRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: ActivityRowToStore): void {
    this.db.prepare(`INSERT INTO activity_log (at, actor_kind, actor_label, session_id, manager_id, source, action, entity_kind, entity_id, entity_label, outcome, duration_ms, detail, args_excerpt, result_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.at, row.actorKind, row.actorLabel, row.sessionId ?? null, row.managerId ?? null, row.source, row.action, row.entityKind ?? null, row.entityId ?? null, row.entityLabel ?? null,
        row.outcome, row.durationMs ?? null, row.detail ?? null, row.argsExcerpt ?? null, row.resultExcerpt ?? null);
  }

  /** Newest first; the cursor is the id of the last row of the previous page. */
  list(query: ActivityQuery): ActivityPage {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    const narrowTo = (condition: string, value: string | number | undefined) => {
      if (value === undefined) return;
      conditions.push(condition);
      values.push(value);
    };
    narrowTo('actor_kind = ?', query.actorKind);
    narrowTo('session_id = ?', query.sessionId);
    narrowTo('manager_id = ?', query.managerId);
    narrowTo('entity_kind = ?', query.entityKind);
    narrowTo('action = ?', query.action);
    narrowTo('outcome = ?', query.outcome);
    narrowTo('at >= ?', query.since);
    narrowTo('at <= ?', query.until);
    narrowTo('id < ?', query.cursor === undefined ? undefined : Number(query.cursor));
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM activity_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values, query.limit + 1) as unknown as StoredActivityRow[];
    const pageRows = rows.slice(0, query.limit);
    const lastRow = pageRows.at(-1);
    const hasMore = rows.length > query.limit;
    const page: ActivityPage = { items: pageRows.map(activityRowOf) };
    if (hasMore && lastRow !== undefined) page.nextCursor = String(lastRow.id);
    return page;
  }

  /** Removes the rows beyond the newest `keepNewest` and those older than `olderThan`; returns how many it removed. */
  prune({ keepNewest, olderThan }: { keepNewest: number; olderThan: string }): number {
    const beyondTheCap = this.db.prepare('DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT ?)').run(keepNewest);
    const tooOld = this.db.prepare('DELETE FROM activity_log WHERE at < ?').run(olderThan);
    return Number(beyondTheCap.changes) + Number(tooOld.changes);
  }
}
