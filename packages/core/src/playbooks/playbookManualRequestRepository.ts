import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';

export type ManualRequestStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface ManualRequestRecord {
  runId: string;
  seq: number;
  promptMasked: string;
  status: ManualRequestStatus;
  decision: 'approved' | 'rejected' | null;
  requestedAt: string;
  expiresAt: string;
}

interface RequestRow { run_id: string; seq: number; prompt_masked: string; status: ManualRequestStatus; decision: 'approved' | 'rejected' | null; requested_at: string; expires_at: string }

export const MANUAL_REJECTED = 'manual_rejected';
export const MANUAL_WAIT_EXPIRED = 'manual_wait_expired';

const toRecord = (row: RequestRow): ManualRequestRecord => ({
  runId: row.run_id, seq: row.seq, promptMasked: row.prompt_masked, status: row.status, decision: row.decision, requestedAt: row.requested_at, expiresAt: row.expires_at,
});

/**
 * The questions manual steps put to a human, and the run and step states that go with them. Every change of a question moves its step and its run in the same transaction,
 * and a question takes one answer: the move from `pending` is an atomic update, so two answers at once settle one of them.
 */
export class PlaybookManualRequestRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Parks the run on its step: the step and the run wait for a human, and the question is written. A secret value never reaches `promptMasked`: the caller masks it. */
  park(input: { runId: string; seq: number; promptMasked: string; requestedAt: string; expiresAt: string }): void {
    inTransaction(this.db, 'playbook_manual_park', () => {
      this.db.prepare("UPDATE playbook_run_steps SET status = 'waiting_manual' WHERE run_id = ? AND seq = ? AND status = 'running'").run(input.runId, input.seq);
      this.db.prepare("INSERT INTO playbook_manual_requests (run_id, seq, prompt_masked, status, requested_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)")
        .run(input.runId, input.seq, input.promptMasked, input.requestedAt, input.expiresAt);
      this.db.prepare("UPDATE playbook_runs SET status = 'waiting_manual' WHERE id = ? AND status = 'running'").run(input.runId);
    });
  }

  get(runId: string, seq: number): ManualRequestRecord | undefined {
    const row = this.db.prepare('SELECT run_id, seq, prompt_masked, status, decision, requested_at, expires_at FROM playbook_manual_requests WHERE run_id = ? AND seq = ?').get(runId, seq) as RequestRow | undefined;
    return row && toRecord(row);
  }

  /** How many runs of the project wait for a human. */
  countParkedInProject(projectId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM playbook_runs r JOIN playbooks p ON p.id = r.playbook_id WHERE r.status = 'waiting_manual' AND p.project_id = ?").get(projectId) as { n: number };
    return row.n;
  }

  /**
   * Records the one answer of a question that is still pending and moves its step and run: an approval ends the step and sets the run running again, a rejection ends both as failed.
   * Returns false, changing nothing, when the question was already answered, expired or cancelled, or when its wait is over at `answeredAt` (the wait ends at `expiresAt` itself).
   */
  answer(input: { runId: string; seq: number; decision: 'approved' | 'rejected'; answeredAt: string }): boolean {
    return inTransaction(this.db, 'playbook_manual_answer', () => {
      const claimed = this.db.prepare("UPDATE playbook_manual_requests SET status = 'answered', decision = ?, settled_at = ? WHERE run_id = ? AND seq = ? AND status = 'pending' AND expires_at > ?")
        .run(input.decision, input.answeredAt, input.runId, input.seq, input.answeredAt);
      const wasPending = Number(claimed.changes) === 1;
      if (!wasPending) return false;
      const output = JSON.stringify({ decision: input.decision });
      if (input.decision === 'approved') {
        this.db.prepare("UPDATE playbook_run_steps SET status = 'succeeded', output_json_masked = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'waiting_manual'").run(output, input.answeredAt, input.runId, input.seq);
        this.db.prepare("UPDATE playbook_runs SET status = 'running' WHERE id = ? AND status = 'waiting_manual'").run(input.runId);
        return true;
      }
      this.db.prepare("UPDATE playbook_run_steps SET status = 'failed', output_json_masked = ?, error_code = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'waiting_manual'").run(output, MANUAL_REJECTED, input.answeredAt, input.runId, input.seq);
      this.db.prepare("UPDATE playbook_runs SET status = 'failed', error_code = ?, ended_at = ? WHERE id = ? AND status = 'waiting_manual'").run(MANUAL_REJECTED, input.answeredAt, input.runId);
      return true;
    });
  }

  /**
   * Closes the question of a run that must not go on, and puts its step and run in review with `errorCode`: a person examines why the human answer could not be applied.
   * Returns false, changing nothing, when the question is not pending or its wait is over at `at` (the wait ends at `expiresAt` itself): the end of the wait wins over a cancellation.
   */
  cancel(input: { runId: string; seq: number; errorCode: string; at: string }): boolean {
    return inTransaction(this.db, 'playbook_manual_cancel', () => {
      const closed = this.db.prepare("UPDATE playbook_manual_requests SET status = 'cancelled', settled_at = ? WHERE run_id = ? AND seq = ? AND status = 'pending' AND expires_at > ?").run(input.at, input.runId, input.seq, input.at);
      if (Number(closed.changes) !== 1) return false;
      this.db.prepare("UPDATE playbook_run_steps SET status = 'needs_review', error_code = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'waiting_manual'").run(input.errorCode, input.at, input.runId, input.seq);
      this.db.prepare("UPDATE playbook_runs SET status = 'needs_review', error_code = ?, ended_at = ? WHERE id = ? AND status = 'waiting_manual'").run(input.errorCode, input.at, input.runId);
      return true;
    });
  }

  /**
   * Abandons the pending question of a waiting run on a cancellation: the question is cancelled, the step and the run end failed with `errorCode`, since nothing was done on their behalf.
   * Returns false, changing nothing, when no question of the run is pending (it was answered, expired or abandoned first).
   */
  abandonPendingQuestion(input: { runId: string; errorCode: string; at: string }): boolean {
    return inTransaction(this.db, 'playbook_manual_abandon', () => {
      const pending = this.db.prepare("SELECT seq FROM playbook_manual_requests WHERE run_id = ? AND status = 'pending'").get(input.runId) as { seq: number } | undefined;
      if (pending === undefined) return false;
      this.db.prepare("UPDATE playbook_manual_requests SET status = 'cancelled', settled_at = ? WHERE run_id = ? AND seq = ? AND status = 'pending'").run(input.at, input.runId, pending.seq);
      this.db.prepare("UPDATE playbook_run_steps SET status = 'failed', error_code = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'waiting_manual'").run(input.errorCode, input.at, input.runId, pending.seq);
      this.db.prepare("UPDATE playbook_runs SET status = 'failed', error_code = ?, ended_at = ? WHERE id = ? AND status = 'waiting_manual'").run(input.errorCode, input.at, input.runId);
      return true;
    });
  }

  /**
   * Ends every wait whose time is over: the question expires and the step and run fail, since nothing was done on their behalf. Returns the runs it ended.
   * With `projectId`, only the waits of the playbooks of that project end.
   */
  expireOverdue(now: string, { projectId }: { projectId?: string } = {}): { runId: string; playbookId: string }[] {
    return inTransaction(this.db, 'playbook_manual_expire', () => {
      const isBoundToAProject = projectId !== undefined;
      const overdue = this.db.prepare(`SELECT m.run_id AS run_id, m.seq AS seq, r.playbook_id AS playbook_id FROM playbook_manual_requests m JOIN playbook_runs r ON r.id = m.run_id
        JOIN playbooks p ON p.id = r.playbook_id WHERE m.status = 'pending' AND m.expires_at <= ?${isBoundToAProject ? ' AND p.project_id = ?' : ''}`).all(now, ...(isBoundToAProject ? [projectId] : [])) as { run_id: string; seq: number; playbook_id: string }[];
      for (const { run_id: runId, seq } of overdue) {
        this.db.prepare("UPDATE playbook_manual_requests SET status = 'expired', settled_at = ? WHERE run_id = ? AND seq = ? AND status = 'pending'").run(now, runId, seq);
        this.db.prepare("UPDATE playbook_run_steps SET status = 'failed', error_code = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'waiting_manual'").run(MANUAL_WAIT_EXPIRED, now, runId, seq);
        this.db.prepare("UPDATE playbook_runs SET status = 'failed', error_code = ?, ended_at = ? WHERE id = ? AND status = 'waiting_manual'").run(MANUAL_WAIT_EXPIRED, now, runId);
      }
      return overdue.map((row) => ({ runId: row.run_id, playbookId: row.playbook_id }));
    });
  }
}
