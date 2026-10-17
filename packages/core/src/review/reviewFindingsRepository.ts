import type { DatabaseSync } from 'node:sqlite';

export type FindingStep = 'qe' | 'qa' | 'ponytail' | 'adversarial';
export type FindingSeverity = 'go' | 'no-go' | 'clean';

export interface ReviewFinding {
  ticket: string;
  step: FindingStep;
  severity: FindingSeverity;
  claim: string;
  /** The reasons the claim joins, kept apart so none is cut at a separator it contains. */
  reasons: string[];
  sha: string;
  authorSessionId: string;
  managerSessionId: string | null;
  createdAt: string;
}

interface Row {
  ticket: string; step: FindingStep; severity: FindingSeverity; claim: string; reasons_json: string; sha: string;
  author_session_id: string; manager_session_id: string | null; created_at: string;
}

const toFinding = (row: Row): ReviewFinding => ({
  ticket: row.ticket, step: row.step, severity: row.severity, claim: row.claim, reasons: JSON.parse(row.reasons_json) as string[], sha: row.sha,
  authorSessionId: row.author_session_id, managerSessionId: row.manager_session_id, createdAt: row.created_at,
});

const COLUMNS = 'ticket, step, severity, claim, reasons_json, sha, author_session_id, manager_session_id, created_at';

/** The findings of the review steps, written by the daemon only: it is the source of truth of the ship gate. */
export class ReviewFindingsRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(finding: ReviewFinding): void {
    this.db.prepare(`INSERT INTO review_findings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(finding.ticket, finding.step, finding.severity, finding.claim, JSON.stringify(finding.reasons), finding.sha, finding.authorSessionId, finding.managerSessionId, finding.createdAt);
  }

  adversarialLinesOf({ ticket }: { ticket: string }): ReviewFinding[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM review_findings WHERE ticket = ? AND step = 'adversarial' ORDER BY id`).all(ticket) as unknown as Row[];
    return rows.map(toFinding);
  }

  /** For each ticket the manager received a verdict about, its most recent adversarial line. */
  latestAdversarialLinePerTicketOf(managerSessionId: string): ReviewFinding[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM review_findings AS line
      WHERE manager_session_id = ? AND step = 'adversarial'
        AND id = (SELECT MAX(id) FROM review_findings WHERE manager_session_id = line.manager_session_id AND step = 'adversarial' AND ticket = line.ticket)
      ORDER BY id`).all(managerSessionId) as unknown as Row[];
    return rows.map(toFinding);
  }
}
