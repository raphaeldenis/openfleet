import type { DatabaseSync } from 'node:sqlite';

/** The restarts the daemon made of each child, kept to bound them in a sliding window. */
export class ChildRestartLedger {
  constructor(private readonly db: DatabaseSync) {}

  record(sessionId: string, at: string): void {
    this.db.prepare('INSERT INTO child_restarts (session_id, at) VALUES (?, ?)').run(sessionId, at);
  }

  /** The restarts of the child recorded at or after `windowStart`. */
  countSince(sessionId: string, windowStart: string): number {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM child_restarts WHERE session_id = ? AND at >= ?').get(sessionId, windowStart) as { count: number };
    return count;
  }
}
