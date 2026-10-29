import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../ids.js';

export type WatchedPrStatus = 'active' | 'closed';

export interface PullRequestRef {
  repo: string;
  number: number;
}

export interface WatchedPr extends PullRequestRef {
  id: string;
  managerId: string;
  status: WatchedPrStatus;
  lastNotifiedSha?: string;
  lastErrorCode?: string;
  lastErrorAt?: string;
  createdAt: string;
}

interface WatchedPrRow {
  id: string; manager_id: string; repo: string; number: number; status: WatchedPrStatus;
  last_notified_sha: string | null; last_error_code: string | null; last_error_at: string | null; created_at: string;
}

const COLUMNS = 'id, manager_id, repo, number, status, last_notified_sha, last_error_code, last_error_at, created_at';

const toWatchedPr = (row: WatchedPrRow): WatchedPr => ({
  id: row.id, managerId: row.manager_id, repo: row.repo, number: row.number, status: row.status,
  ...(row.last_notified_sha !== null && { lastNotifiedSha: row.last_notified_sha }),
  ...(row.last_error_code !== null && { lastErrorCode: row.last_error_code }),
  ...(row.last_error_at !== null && { lastErrorAt: row.last_error_at }),
  createdAt: row.created_at,
});

export class WatchedPrRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Watches the pull request for the manager; watching it again reactivates it and keeps its notified sha. */
  watch({ managerId, repo, number }: PullRequestRef & { managerId: string }): WatchedPr {
    this.db.prepare(`INSERT INTO watched_prs (${COLUMNS}) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?)
      ON CONFLICT (manager_id, repo, number) DO UPDATE SET status = 'active'`)
      .run(newId(), managerId, repo, number, new Date().toISOString());
    return this.requireWatched({ managerId, repo, number });
  }

  /** True when the manager was watching the pull request. */
  unwatch({ managerId, repo, number }: PullRequestRef & { managerId: string }): boolean {
    const result = this.db.prepare('DELETE FROM watched_prs WHERE manager_id = ? AND repo = ? AND number = ?').run(managerId, repo, number);
    return Number(result.changes) > 0;
  }

  activeOf(managerId: string): WatchedPr[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM watched_prs WHERE manager_id = ? AND status = 'active' ORDER BY created_at, id`).all(managerId) as unknown as WatchedPrRow[];
    return rows.map(toWatchedPr);
  }

  allActive(): WatchedPr[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM watched_prs WHERE status = 'active' ORDER BY created_at, id`).all() as unknown as WatchedPrRow[];
    return rows.map(toWatchedPr);
  }

  countActiveOf(managerId: string): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM watched_prs WHERE manager_id = ? AND status = 'active'`).get(managerId) as { n: number };
    return row.n;
  }

  close(id: string): void {
    this.db.prepare(`UPDATE watched_prs SET status = 'closed' WHERE id = ?`).run(id);
  }

  recordNotified(id: string, sha: string): void {
    this.db.prepare('UPDATE watched_prs SET last_notified_sha = ? WHERE id = ?').run(sha, id);
  }

  /** Stores the code of the last failed poll; no code clears it. */
  recordError(id: string, code: string | undefined): void {
    const errorAt = code === undefined ? null : new Date().toISOString();
    this.db.prepare('UPDATE watched_prs SET last_error_code = ?, last_error_at = ? WHERE id = ?').run(code ?? null, errorAt, id);
  }

  private requireWatched({ managerId, repo, number }: PullRequestRef & { managerId: string }): WatchedPr {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM watched_prs WHERE manager_id = ? AND repo = ? AND number = ?`).get(managerId, repo, number) as WatchedPrRow | undefined;
    if (!row) throw new Error(`watched pull request ${repo}#${number} vanished after insert`);
    return toWatchedPr(row);
  }
}
