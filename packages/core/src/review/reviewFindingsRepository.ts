import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ReproClaim } from '@openfleet/shared';
import { inTransaction } from '../db/transaction.js';

export type FindingStep = 'qe' | 'qa' | 'ponytail' | 'adversarial';
export type FindingSeverity = 'go' | 'no-go' | 'clean';

/** What backs a claim: the run (command and output) that shows it, or the not_reproduced label. */
export type ReproEvidence = Omit<ReproClaim, 'claim'>;

export interface ReviewFinding {
  ticket: string;
  step: FindingStep;
  severity: FindingSeverity;
  claim: string;
  /** The reasons the claim joins, kept apart so none is cut at a separator it contains. */
  reasons: string[];
  /** The evidence of each reason, in the same order; absent on a report that carries none. */
  repros?: ReproEvidence[];
  sha: string;
  authorSessionId: string;
  managerSessionId: string | null;
  createdAt: string;
}

/** The steps a human may waive; the adversarial review is never one of them. */
export type SkippableStep = Exclude<FindingStep, 'adversarial'>;
export const SKIPPABLE_STEPS: readonly SkippableStep[] = ['qe', 'qa', 'ponytail'];

/** `headSha` is the head the human named, `author` who waived the step; both are absent on skips that predate them. */
export interface StepSkip { ticket: string; step: SkippableStep; reason: string; createdAt: string; headSha?: string; author?: string }

interface SkipRow { ticket: string; step: SkippableStep; reason: string; createdAt: string; headSha: string | null; author: string | null }

const toSkip = (row: SkipRow): StepSkip => ({
  ticket: row.ticket, step: row.step, reason: row.reason, createdAt: row.createdAt,
  ...(row.headSha === null ? {} : { headSha: row.headSha }),
  ...(row.author === null ? {} : { author: row.author }),
});

interface Row {
  ticket: string; step: FindingStep; severity: FindingSeverity; claim: string; reasons_json: string; sha: string;
  author_session_id: string; manager_session_id: string | null; created_at: string;
}

const toFinding = (row: Row): ReviewFinding => ({
  ticket: row.ticket, step: row.step, severity: row.severity, claim: row.claim, reasons: JSON.parse(row.reasons_json) as string[], sha: row.sha,
  authorSessionId: row.author_session_id, managerSessionId: row.manager_session_id, createdAt: row.created_at,
});

/** One finding of a structured report; a report with no finding has one item that says so. */
export interface ReviewFindingItem {
  reportId: string;
  position: number;
  ticket: string;
  step: FindingStep;
  severity: FindingSeverity;
  claim: string;
  sha: string;
  authorSessionId: string;
  managerSessionId: string | null;
  createdAt: string;
  /** The reproduction of the finding; null on an item recorded without one. */
  repro: ReproEvidence | null;
}

export const NO_FINDINGS_CLAIM = '0 findings';

/** The same report, sent again, has the same id: it names the ticket, the step, the commit, the author, the severity, the claims and their evidence. */
const reportIdOf = (finding: ReviewFinding): string => {
  const evidence = finding.repros === undefined ? [] : [finding.repros];
  return createHash('sha256').update(JSON.stringify([finding.ticket, finding.step, finding.sha, finding.authorSessionId, finding.severity, finding.reasons, ...evidence])).digest('hex');
};

interface ItemRow {
  report_id: string; position: number; ticket: string; step: FindingStep; severity: FindingSeverity; claim: string; sha: string;
  author_session_id: string; manager_session_id: string | null; created_at: string;
  repro_status: ReproEvidence['status'] | null; repro_command: string | null; repro_output: string | null;
}

const toRepro = (row: ItemRow): ReproEvidence | null => {
  if (row.repro_status === null) return null;
  return { status: row.repro_status, ...(row.repro_command === null ? {} : { command: row.repro_command }), ...(row.repro_output === null ? {} : { output: row.repro_output }) };
};

const toItem = (row: ItemRow): ReviewFindingItem => ({
  reportId: row.report_id, position: row.position, ticket: row.ticket, step: row.step, severity: row.severity, claim: row.claim, sha: row.sha,
  authorSessionId: row.author_session_id, managerSessionId: row.manager_session_id, createdAt: row.created_at, repro: toRepro(row),
});

const NOT_REPRODUCED: ReproEvidence = { status: 'not_reproduced' };

/** The report id ignores the date, so a report sent again keeps the items of the first one: the match leaves the date out. */
const isItemOfLine = (line: ReviewFinding) => (item: ReviewFindingItem): boolean =>
  item.step === line.step && item.sha === line.sha && item.severity === line.severity && item.authorSessionId === line.authorSessionId;

/** A line with no recorded reproduction on any of its items keeps no `repros`: it is an old-form line. */
const withReprosOf = (line: ReviewFinding, items: ReviewFindingItem[]): ReviewFinding => {
  const itemsOfLine = items.filter(isItemOfLine(line)).sort((first, second) => first.position - second.position);
  const hasRecordedRepro = itemsOfLine.some((item) => item.repro !== null);
  if (!hasRecordedRepro) return line;
  return { ...line, repros: itemsOfLine.map((item) => item.repro ?? NOT_REPRODUCED) };
};

const ITEM_COLUMNS = 'report_id, position, ticket, step, severity, claim, sha, author_session_id, manager_session_id, created_at, repro_status, repro_command, repro_output';

const COLUMNS = 'ticket, step, severity, claim, reasons_json, sha, author_session_id, manager_session_id, created_at';

/** The findings of the review steps, written by the daemon only: it is the source of truth of the ship gate. */
export class ReviewFindingsRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Writes the report line and one item per finding of the report, in one transaction. */
  record(finding: ReviewFinding): void {
    inTransaction(this.db, 'record review finding', () => {
      this.db.prepare(`INSERT INTO review_findings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(finding.ticket, finding.step, finding.severity, finding.claim, JSON.stringify(finding.reasons), finding.sha, finding.authorSessionId, finding.managerSessionId, finding.createdAt);
      this.recordItemsOf(finding);
    });
  }

  /** Every finding of a ticket, one row each, oldest report first. */
  itemsOf({ ticket }: { ticket: string }): ReviewFindingItem[] {
    const rows = this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM review_finding_items WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  /** A report already recorded leaves no new row: its report id and position are unique. */
  private recordItemsOf(finding: ReviewFinding): void {
    const reportId = reportIdOf(finding);
    const claims = finding.reasons.length === 0 ? [NO_FINDINGS_CLAIM] : finding.reasons;
    const insertItem = this.db.prepare(`INSERT OR IGNORE INTO review_finding_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    claims.forEach((claim, position) => {
      const repro = finding.reasons.length === 0 ? undefined : finding.repros?.[position];
      insertItem.run(
        reportId, position, finding.ticket, finding.step, finding.severity, claim, finding.sha, finding.authorSessionId, finding.managerSessionId, finding.createdAt,
        repro?.status ?? null, repro?.command ?? null, repro?.output ?? null,
      );
    });
  }

  /** Every line of a ticket, oldest first, with the reproduction of its claims when the report recorded one. */
  linesOf({ ticket }: { ticket: string }): ReviewFinding[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM review_findings WHERE ticket = ? ORDER BY id`).all(ticket) as unknown as Row[];
    const items = this.itemsOf({ ticket });
    return rows.map((row) => withReprosOf(toFinding(row), items));
  }

  recordSkip(skip: StepSkip): void {
    this.db.prepare('INSERT INTO review_step_skips (ticket, step, reason, created_at, head_sha, author) VALUES (?, ?, ?, ?, ?, ?)')
      .run(skip.ticket, skip.step, skip.reason, skip.createdAt, skip.headSha ?? null, skip.author ?? null);
  }

  skipsOf({ ticket }: { ticket: string }): StepSkip[] {
    const rows = this.db.prepare('SELECT ticket, step, reason, created_at AS createdAt, head_sha AS headSha, author FROM review_step_skips WHERE ticket = ? ORDER BY id').all(ticket) as unknown as SkipRow[];
    return rows.map(toSkip);
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
