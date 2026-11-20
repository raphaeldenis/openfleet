import { PlaybookRunLauncherSchema, type PlaybookRunActorKind, type PlaybookRunLauncher, type PlaybookRunStatus } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';

/** How many of the most recent steps `parentOf` looks at: the lookup stays cheap however many steps the journal holds. */
export const PARENT_LOOKUP_SCAN_LIMIT = 10_000;

/** The states a step or a run ends in: neither running nor waiting for a human. */
export type SettledStatus = Exclude<PlaybookRunStatus, 'running' | 'waiting_manual'>;

export interface PlaybookRunRecord {
  id: string;
  playbookId: string;
  playbookRev: number;
  flowSha256: string;
  status: PlaybookRunStatus;
  /** The inputs of the run with every secret value already masked. */
  inputs: Record<string, unknown>;
  actorKind: PlaybookRunActorKind;
  /** Who started the run, fixed at its creation; a run created before the column existed reads as unknown. */
  launchedBy: PlaybookRunLauncher;
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
  actor_kind: PlaybookRunActorKind; launched_by_kind: string | null; launched_by_ref: string | null; error_code: string | null; started_at: string; ended_at: string | null;
}
interface StepRow { seq: number; step_id: string; status: PlaybookRunStatus; output_json_masked: string | null; error_code: string | null; started_at: string; ended_at: string | null }

const RUN_COLUMNS = 'id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, launched_by_kind, launched_by_ref, error_code, started_at, ended_at';

const UNKNOWN_LAUNCHER: PlaybookRunLauncher = { kind: 'unknown', ref: null };
const launcherOf = (row: RunRow): PlaybookRunLauncher =>
  row.launched_by_kind === null ? UNKNOWN_LAUNCHER : PlaybookRunLauncherSchema.parse({ kind: row.launched_by_kind, ref: row.launched_by_ref });

const toRun = (row: RunRow): PlaybookRunRecord => ({
  id: row.id, playbookId: row.playbook_id, playbookRev: row.playbook_rev, flowSha256: row.flow_sha256, status: row.status, inputs: JSON.parse(row.inputs_json),
  actorKind: row.actor_kind, launchedBy: launcherOf(row), errorCode: row.error_code, startedAt: row.started_at, endedAt: row.ended_at,
});
const toStep = (row: StepRow): PlaybookRunStepRecord => ({
  seq: row.seq, stepId: row.step_id, status: row.status, output: row.output_json_masked === null ? null : JSON.parse(row.output_json_masked),
  errorCode: row.error_code, startedAt: row.started_at, endedAt: row.ended_at,
});

/** The journal of the runs: a step is written `running` before its effect and settled after it; nothing here ever restarts a step. */
export class PlaybookRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertRun(run: Pick<PlaybookRunRecord, 'id' | 'playbookId' | 'playbookRev' | 'flowSha256' | 'inputs' | 'actorKind' | 'launchedBy' | 'startedAt'>): void {
    const launchedBy = PlaybookRunLauncherSchema.parse(run.launchedBy);
    this.db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, launched_by_kind, launched_by_ref, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
      .run(run.id, run.playbookId, run.playbookRev, run.flowSha256, JSON.stringify(run.inputs), run.actorKind, launchedBy.kind, launchedBy.ref, run.startedAt);
  }

  insertStep(step: { runId: string; seq: number; stepId: string; startedAt: string }): void {
    this.db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(step.runId, step.seq, step.stepId, step.startedAt);
  }

  /** Settles a step that is running; the output is stored as given, so the caller masks it first. */
  settleStep(step: { runId: string; seq: number; status: SettledStatus; output?: unknown; errorCode?: string; endedAt: string }): void {
    this.db.prepare("UPDATE playbook_run_steps SET status = ?, output_json_masked = ?, error_code = ?, ended_at = ? WHERE run_id = ? AND seq = ? AND status = 'running'")
      .run(step.status, step.output === undefined ? null : JSON.stringify(step.output), step.errorCode ?? null, step.endedAt, step.runId, step.seq);
  }

  /** Rewrites the output of a step that is still running (a subPlaybook step names its child before the child starts); a settled step is left as it is. */
  writeRunningStepOutput(step: { runId: string; seq: number; output: unknown }): void {
    this.db.prepare("UPDATE playbook_run_steps SET output_json_masked = ? WHERE run_id = ? AND seq = ? AND status = 'running'").run(JSON.stringify(step.output), step.runId, step.seq);
  }

  /**
   * Journals a run called by another one and the link in the step of its parent (`{ childRunId, status: 'running' }`) in one transaction.
   * Nothing is written, and `parent_gone` answers, when the parent run is not running any more or its step is not running: a parent whose playbook was deleted leaves no child behind.
   */
  insertRunLinkedToStep(input: { run: Parameters<PlaybookRunRepository['insertRun']>[0]; parentStep: { runId: string; seq: number } }): 'inserted' | 'parent_gone' {
    return inTransaction(this.db, 'playbook_runs_insert_linked', () => {
      const parentRun = this.db.prepare("SELECT 1 AS running FROM playbook_runs WHERE id = ? AND status = 'running'").get(input.parentStep.runId);
      if (parentRun === undefined) return 'parent_gone';
      const link = this.db.prepare("UPDATE playbook_run_steps SET output_json_masked = ? WHERE run_id = ? AND seq = ? AND status = 'running'")
        .run(JSON.stringify({ childRunId: input.run.id, status: 'running' }), input.parentStep.runId, input.parentStep.seq);
      if (Number(link.changes) !== 1) return 'parent_gone';
      this.insertRun(input.run);
      return 'inserted';
    });
  }

  /**
   * The step of the parent run whose output names `childRunId` (`{ childRunId }`, written by the runner), only when that child run exists and both runs belong to the same project.
   * Only the PARENT_LOOKUP_SCAN_LIMIT most recent steps are read.
   */
  parentOf(childRunId: string): { runId: string; seq: number } | undefined {
    const row = this.db.prepare(`SELECT link.run_id, link.seq
      FROM (SELECT run_id, seq, output_json_masked FROM playbook_run_steps ORDER BY rowid DESC LIMIT ?) AS link
      JOIN playbook_runs AS parent_run ON parent_run.id = link.run_id
      JOIN playbooks AS parent_playbook ON parent_playbook.id = parent_run.playbook_id
      JOIN playbook_runs AS child_run ON child_run.id = ?
      JOIN playbooks AS child_playbook ON child_playbook.id = child_run.playbook_id
      WHERE parent_playbook.project_id = child_playbook.project_id
        AND CASE WHEN json_valid(link.output_json_masked) THEN json_extract(link.output_json_masked, '$.childRunId') END = ?
      LIMIT 1`).get(PARENT_LOOKUP_SCAN_LIMIT, childRunId, childRunId) as { run_id: string; seq: number } | undefined;
    return row && { runId: row.run_id, seq: row.seq };
  }

  settleRun(run: { id: string; status: SettledStatus; errorCode?: string; endedAt: string }): void {
    this.db.prepare("UPDATE playbook_runs SET status = ?, error_code = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(run.status, run.errorCode ?? null, run.endedAt, run.id);
  }

  get(id: string): PlaybookRunRecord | undefined {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM playbook_runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row && toRun(row);
  }

  /** The stored output of one step (null when it holds none, undefined when the step does not exist). */
  stepOutputOf(runId: string, seq: number): unknown {
    const row = this.db.prepare('SELECT output_json_masked FROM playbook_run_steps WHERE run_id = ? AND seq = ?').get(runId, seq) as { output_json_masked: string | null } | undefined;
    if (row === undefined) return undefined;
    return row.output_json_masked === null ? null : JSON.parse(row.output_json_masked);
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

  /** A page of the runs of a project, newest first, optionally of one playbook of that project. */
  listPageOfProject(input: { projectId: string; playbookId?: string; limit: number; offset: number }): PlaybookRunRecord[] {
    const filterOnPlaybook = input.playbookId === undefined ? '' : 'AND playbook_runs.playbook_id = ?';
    const columns = RUN_COLUMNS.split(', ').map((column) => `playbook_runs.${column}`).join(', ');
    const parameters = [input.projectId, ...(input.playbookId === undefined ? [] : [input.playbookId]), input.limit, input.offset];
    const rows = this.db.prepare(`SELECT ${columns} FROM playbook_runs JOIN playbooks ON playbooks.id = playbook_runs.playbook_id
      WHERE playbooks.project_id = ? ${filterOnPlaybook} ORDER BY playbook_runs.started_at DESC, playbook_runs.rowid DESC LIMIT ? OFFSET ?`).all(...parameters) as unknown as RunRow[];
    return rows.map(toRun);
  }

  countRunning(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM playbook_runs WHERE status = 'running'").get() as { n: number }).n;
  }

  countNeedingReview(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM playbook_runs WHERE status = 'needs_review'").get() as { n: number }).n;
  }

  /** A playbook is in progress while a run of it runs or waits for a human: a parked run holds the playbook, but not one of the runs at once. */
  isRunning(playbookId: string): boolean {
    return this.db.prepare("SELECT 1 AS running FROM playbook_runs WHERE playbook_id = ? AND status IN ('running', 'waiting_manual') LIMIT 1").get(playbookId) !== undefined;
  }

  /** Marks every run and step still running as needs_review, and returns how many runs it touched. A step that was running may have had its effect: it is never started again. */
  interruptEverythingRunning(input: { errorCode: string; endedAt: string }): number {
    return inTransaction(this.db, 'playbook_runs_interrupt', () => {
      this.db.prepare("UPDATE playbook_run_steps SET status = 'needs_review', error_code = ?, ended_at = ? WHERE status = 'running'").run(input.errorCode, input.endedAt);
      const runs = this.db.prepare("UPDATE playbook_runs SET status = 'needs_review', error_code = ?, ended_at = ? WHERE status = 'running'").run(input.errorCode, input.endedAt);
      return Number(runs.changes);
    });
  }

  /** Deletes the oldest succeeded and failed runs of the playbook beyond the `keep` newest. A run that is running or needs review is never deleted here: its journal is the only evidence of an effect nobody has examined. */
  pruneFinishedBeyond(playbookId: string, keep: number): void {
    this.db.prepare(`DELETE FROM playbook_runs WHERE playbook_id = ? AND status IN ('succeeded', 'failed') AND id NOT IN (
        SELECT id FROM playbook_runs WHERE playbook_id = ? AND status IN ('succeeded', 'failed') ORDER BY started_at DESC, id DESC LIMIT ?)`).run(playbookId, playbookId, keep);
  }
}
