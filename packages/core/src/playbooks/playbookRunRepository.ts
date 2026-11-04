import type { PlaybookRunActorKind, PlaybookRunStatus } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';

export interface PlaybookRunRecord {
  id: string;
  playbookId: string;
  playbookRev: number;
  flowSha256: string;
  status: PlaybookRunStatus;
  /** The inputs of the run with every secret value already masked. */
  inputs: Record<string, unknown>;
  actorKind: PlaybookRunActorKind;
  errorCode: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PlaybookRunStepRecord {
  seq: number;
  stepId: string;
  status: PlaybookRunStatus;
  /** What the step produced, with every secret value already masked. */
  output: unknown;
  errorCode: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface RunRow {
  id: string; playbook_id: string; playbook_rev: number; flow_sha256: string; status: PlaybookRunStatus; inputs_json: string;
  actor_kind: PlaybookRunActorKind; error_code: string | null; started_at: string; ended_at: string | null;
}
interface StepRow { seq: number; step_id: string; status: PlaybookRunStatus; output_json_masked: string | null; error_code: string | null; started_at: string; ended_at: string | null }

const RUN_COLUMNS = 'id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, error_code, started_at, ended_at';

const toRun = (row: RunRow): PlaybookRunRecord => ({
  id: row.id, playbookId: row.playbook_id, playbookRev: row.playbook_rev, flowSha256: row.flow_sha256, status: row.status, inputs: JSON.parse(row.inputs_json),
  actorKind: row.actor_kind, errorCode: row.error_code, startedAt: row.started_at, endedAt: row.ended_at,
});
const toStep = (row: StepRow): PlaybookRunStepRecord => ({
  seq: row.seq, stepId: row.step_id, status: row.status, output: row.output_json_masked === null ? null : JSON.parse(row.output_json_masked),
  errorCode: row.error_code, startedAt: row.started_at, endedAt: row.ended_at,
});

/** The journal of the runs: a step is written `running` before its effect and settled after it; nothing here ever restarts a step. */
export class PlaybookRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertRun(run: Pick<PlaybookRunRecord, 'id' | 'playbookId' | 'playbookRev' | 'flowSha256' | 'inputs' | 'actorKind' | 'startedAt'>): void {
    this.db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)")
      .run(run.id, run.playbookId, run.playbookRev, run.flowSha256, JSON.stringify(run.inputs), run.actorKind, run.startedAt);
  }

  insertStep(step: { runId: string; seq: number; stepId: string; startedAt: string }): void {
    this.db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(step.runId, step.seq, step.stepId, step.startedAt);
  }

  /** Settles a step that is running; the output is stored as given, so the caller masks it first. */
  settleStep(step: { runId: string; seq: number; status: Exclude<PlaybookRunStatus, 'running'>; output?: unknown; errorCode?: string; endedAt: string }): void {
    this.db.prepare("UPDATE playbook_run_steps SET status = ?, output_json_masked = ?, error_code = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'running'")
      .run(step.status, step.output === undefined ? null : JSON.stringify(step.output), step.errorCode ?? null, step.endedAt, step.runId, step.seq);
  }

  settleRun(run: { id: string; status: Exclude<PlaybookRunStatus, 'running'>; errorCode?: string; endedAt: string }): void {
    this.db.prepare("UPDATE playbook_runs SET status = ?, error_code = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(run.status, run.errorCode ?? null, run.endedAt, run.id);
  }

  get(id: string): PlaybookRunRecord | undefined {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM playbook_runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row && toRun(row);
  }

  stepsOf(runId: string): PlaybookRunStepRecord[] {
    const rows = this.db.prepare('SELECT seq, step_id, status, output_json_masked, error_code, started_at, ended_at FROM playbook_run_steps WHERE run_id = ? ORDER BY seq').all(runId) as unknown as StepRow[];
    return rows.map(toStep);
  }

  /** The runs of a playbook, oldest first. */
  listOfPlaybook(playbookId: string): PlaybookRunRecord[] {
    const rows = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM playbook_runs WHERE playbook_id = ? ORDER BY started_at, id`).all(playbookId) as unknown as RunRow[];
    return rows.map(toRun);
  }

  countRunning(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM playbook_runs WHERE status = 'running'").get() as { n: number }).n;
  }

  isRunning(playbookId: string): boolean {
    return this.db.prepare("SELECT 1 AS running FROM playbook_runs WHERE playbook_id = ? AND status = 'running' LIMIT 1").get(playbookId) !== undefined;
  }

  /** Marks every run and step still running as needs_review, and returns how many runs it touched. A step that was running may have had its effect: it is never started again. */
  interruptEverythingRunning(input: { errorCode: string; endedAt: string }): number {
    return inTransaction(this.db, 'playbook_runs_interrupt', () => {
      this.db.prepare("UPDATE playbook_run_steps SET status = 'needs_review', error_code = ?, ended_at = ? WHERE status = 'running'").run(input.errorCode, input.endedAt);
      const runs = this.db.prepare("UPDATE playbook_runs SET status = 'needs_review', error_code = ?, ended_at = ? WHERE status = 'running'").run(input.errorCode, input.endedAt);
      return Number(runs.changes);
    });
  }

  /** Deletes the oldest finished runs of the playbook beyond the `keep` newest. */
  pruneFinishedBeyond(playbookId: string, keep: number): void {
    this.db.prepare(`DELETE FROM playbook_runs WHERE playbook_id = ? AND status <> 'running' AND id NOT IN (
        SELECT id FROM playbook_runs WHERE playbook_id = ? AND status <> 'running' ORDER BY started_at DESC, id DESC LIMIT ?)`).run(playbookId, playbookId, keep);
  }
}
