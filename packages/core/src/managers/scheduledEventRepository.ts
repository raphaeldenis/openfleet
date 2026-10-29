import type { DatabaseSync } from 'node:sqlite';

export type ScheduledEventCreator = 'manager' | 'human';
export type ScheduledEventStatus = 'pending' | 'delivered' | 'cancelled';

export interface ScheduledEvent {
  id: string;
  managerId: string;
  creator: ScheduledEventCreator;
  title?: string;
  message: string;
  dueAt: string;
  status: ScheduledEventStatus;
  createdAt: string;
  deliveredAt?: string;
}

interface ScheduledEventRow {
  id: string; manager_id: string; creator: ScheduledEventCreator; title: string | null; message: string;
  due_at: string; status: ScheduledEventStatus; created_at: string; delivered_at: string | null;
}

const COLUMNS = 'id, manager_id, creator, title, message, due_at, status, created_at, delivered_at';

const toEvent = (row: ScheduledEventRow): ScheduledEvent => ({
  id: row.id, managerId: row.manager_id, creator: row.creator, ...(row.title !== null && { title: row.title }), message: row.message,
  dueAt: row.due_at, status: row.status, createdAt: row.created_at, ...(row.delivered_at !== null && { deliveredAt: row.delivered_at }),
});

export class ScheduledEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(event: Omit<ScheduledEvent, 'status' | 'deliveredAt'>): void {
    this.db.prepare(`INSERT INTO argus_scheduled_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
      .run(event.id, event.managerId, event.creator, event.title ?? null, event.message, event.dueAt, event.createdAt);
  }

  get(id: string): ScheduledEvent | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM argus_scheduled_events WHERE id = ?`).get(id) as ScheduledEventRow | undefined;
    return row && toEvent(row);
  }

  /** The pending events of a manager, soonest first. */
  pendingOf(managerId: string): ScheduledEvent[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM argus_scheduled_events WHERE manager_id = ? AND status = 'pending' ORDER BY due_at, created_at, id`).all(managerId) as unknown as ScheduledEventRow[];
    return rows.map(toEvent);
  }

  /** The managers that have at least one pending event. */
  managerIdsWithPendingEvents(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT manager_id FROM argus_scheduled_events WHERE status = 'pending'`).all() as { manager_id: string }[];
    return rows.map((row) => row.manager_id);
  }

  countPendingOf(managerId: string): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM argus_scheduled_events WHERE manager_id = ? AND status = 'pending'`).get(managerId) as { n: number };
    return row.n;
  }

  /** True when the event was still pending and now has the status. */
  settle(id: string, status: 'delivered' | 'cancelled'): boolean {
    const deliveredAt = status === 'delivered' ? new Date().toISOString() : null;
    const result = this.db.prepare(`UPDATE argus_scheduled_events SET status = ?, delivered_at = ? WHERE id = ? AND status = 'pending'`).run(status, deliveredAt, id);
    return Number(result.changes) > 0;
  }
}
