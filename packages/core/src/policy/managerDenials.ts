import type { DatabaseSync } from 'node:sqlite';
import type { DeniedCommand } from '@openfleet/shared';
import type { DeniedCommandCounts } from '../managers/managerView.js';
import { denialOf, type DenialRow } from './sqliteDenialJournal.js';

export interface ManagerDenialRead {
  managerId: string;
  /** The sessions of the manager's lineage whose refusals can be read. */
  lineageSessionIds: string[];
  since?: string;
  limit: number;
  /** An unfiltered read marks every refusal of the lineage as seen. */
  marksAsSeen: boolean;
}

export interface ManagerDenialPage {
  denials: DeniedCommand[];
  /** Matching entries older than the ones returned. */
  notShownCount: number;
}

/** What a manager knows of the refusals of its lineage: a count of those it has not looked at, and the list. */
export class ManagerDenials {
  constructor(private readonly deps: { db: DatabaseSync; lineageSessionIdsOf: (managerId: string) => string[] }) {}

  /** `deniedCommandCount` is the refusals not looked at since the last unfiltered read; observed commands count for nothing. */
  countsOf(managerId: string): DeniedCommandCounts {
    const lineageSessionIds = JSON.stringify(this.deps.lineageSessionIdsOf(managerId));
    const lastSeenRowid = this.lastSeenRowidOf(managerId);
    const counts = this.deps.db.prepare(`SELECT count(*) AS total, coalesce(sum(rowid > ?), 0) AS unseen FROM denied_commands
      WHERE outcome = 'denied' AND session_id IN (SELECT value FROM json_each(?))`).get(lastSeenRowid, lineageSessionIds) as { total: number; unseen: number };
    return { deniedCommandCount: counts.unseen, deniedCommandTotal: counts.total };
  }

  read({ managerId, lineageSessionIds, since, limit, marksAsSeen }: ManagerDenialRead): ManagerDenialPage {
    const sessionIds = JSON.stringify(lineageSessionIds);
    const sinceCondition = since === undefined ? '' : 'AND created_at >= ?';
    const filterValues = since === undefined ? [sessionIds] : [sessionIds, since];
    const matching = `FROM denied_commands WHERE session_id IN (SELECT value FROM json_each(?)) ${sinceCondition}`;
    const rows = this.deps.db.prepare(`SELECT rowid, * ${matching} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...filterValues, limit) as unknown as DenialRow[];
    const matchingCount = (this.deps.db.prepare(`SELECT count(*) AS n ${matching}`).get(...filterValues) as { n: number }).n;
    if (marksAsSeen) this.markSeenUpToNewestOf(managerId, sessionIds);
    return { denials: rows.map(denialOf), notShownCount: matchingCount - rows.length };
  }

  private lastSeenRowidOf(managerId: string): number {
    const cursor = this.deps.db.prepare('SELECT last_seen_rowid FROM denial_read_cursors WHERE manager_id = ?').get(managerId) as { last_seen_rowid: number } | undefined;
    return cursor?.last_seen_rowid ?? 0;
  }

  private markSeenUpToNewestOf(managerId: string, lineageSessionIds: string): void {
    const newest = this.deps.db.prepare('SELECT max(rowid) AS rowid FROM denied_commands WHERE session_id IN (SELECT value FROM json_each(?))').get(lineageSessionIds) as { rowid: number | null };
    if (newest.rowid === null) return;
    this.deps.db.prepare(`INSERT INTO denial_read_cursors (manager_id, last_seen_rowid) VALUES (?, ?)
      ON CONFLICT(manager_id) DO UPDATE SET last_seen_rowid = max(last_seen_rowid, excluded.last_seen_rowid)`).run(managerId, newest.rowid);
  }
}
