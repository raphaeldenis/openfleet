import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { PARENT_LOOKUP_SCAN_LIMIT, PlaybookRunRepository } from './playbookRunRepository.js';

const PLAYBOOK_ID = 'pb1';

const arrangeRepository = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES (?, 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run(PLAYBOOK_ID);
  return { db, runs: new PlaybookRunRepository(db) };
};

type Repository = ReturnType<typeof arrangeRepository>['runs'];

const addRun = (runs: Repository, { id, startedAt, status }: { id: string; startedAt: string; status: 'running' | 'succeeded' | 'failed' | 'needs_review' }) => {
  runs.insertRun({ id, playbookId: PLAYBOOK_ID, playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin', startedAt });
  runs.insertStep({ runId: id, seq: 1, stepId: 'build', startedAt });
  if (status === 'running') return;
  runs.settleStep({ runId: id, seq: 1, status, output: { output: `output of ${id}` }, endedAt: startedAt });
  runs.settleRun({ id, status, endedAt: startedAt });
};

const idsKept = (runs: Repository) => runs.listOfPlaybook(PLAYBOOK_ID).map((run) => run.id);

describe('the retention of the runs of a playbook', () => {
  it('deletes the oldest finished runs beyond the newest it keeps', () => {
    const { runs } = arrangeRepository();
    addRun(runs, { id: 'old', startedAt: '2026-01-01', status: 'succeeded' });
    addRun(runs, { id: 'middle', startedAt: '2026-01-02', status: 'failed' });
    addRun(runs, { id: 'new', startedAt: '2026-01-03', status: 'succeeded' });

    runs.pruneFinishedBeyond(PLAYBOOK_ID, 2);

    expect(idsKept(runs)).toEqual(['middle', 'new']);
  });

  it('keeps a run that needs review, and its steps, however old and however many finished runs follow', () => {
    const { db, runs } = arrangeRepository();
    addRun(runs, { id: 'ambiguous-effect', startedAt: '2026-01-01', status: 'needs_review' });
    addRun(runs, { id: 'later-1', startedAt: '2026-01-02', status: 'succeeded' });
    addRun(runs, { id: 'later-2', startedAt: '2026-01-03', status: 'succeeded' });

    runs.pruneFinishedBeyond(PLAYBOOK_ID, 1);

    expect(idsKept(runs)).toEqual(['ambiguous-effect', 'later-2']);
    expect(runs.stepsOf('ambiguous-effect')).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM playbook_run_steps WHERE run_id = 'ambiguous-effect'").get()).toEqual({ n: 1 });
  });

  it('does not count a run that needs review among the finished runs it keeps', () => {
    const { runs } = arrangeRepository();
    addRun(runs, { id: 'old', startedAt: '2026-01-01', status: 'succeeded' });
    addRun(runs, { id: 'ambiguous-effect', startedAt: '2026-01-02', status: 'needs_review' });
    addRun(runs, { id: 'new', startedAt: '2026-01-03', status: 'succeeded' });

    runs.pruneFinishedBeyond(PLAYBOOK_ID, 1);

    expect(idsKept(runs)).toEqual(['ambiguous-effect', 'new']);
  });

  it('keeps a run that is running', () => {
    const { runs } = arrangeRepository();
    addRun(runs, { id: 'in-flight', startedAt: '2026-01-01', status: 'running' });
    addRun(runs, { id: 'new', startedAt: '2026-01-02', status: 'succeeded' });

    runs.pruneFinishedBeyond(PLAYBOOK_ID, 1);

    expect(idsKept(runs)).toEqual(['in-flight', 'new']);
  });

  it('prunes the runs of one playbook only', () => {
    const { db, runs } = arrangeRepository();
    db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb2', 'p1', 'Q', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
    addRun(runs, { id: 'mine-old', startedAt: '2026-01-01', status: 'succeeded' });
    addRun(runs, { id: 'mine-new', startedAt: '2026-01-02', status: 'succeeded' });
    runs.insertRun({ id: 'theirs', playbookId: 'pb2', playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin', startedAt: '2026-01-01' });
    runs.settleRun({ id: 'theirs', status: 'succeeded', endedAt: '2026-01-01' });

    runs.pruneFinishedBeyond(PLAYBOOK_ID, 1);

    expect(idsKept(runs)).toEqual(['mine-new']);
    expect(runs.listOfPlaybook('pb2').map((run) => run.id)).toEqual(['theirs']);
  });
});

describe('the link from a child run to the step of its parent', () => {
  const addParentStep = (runs: Repository, { runId, output }: { runId: string; output: unknown }) => {
    runs.insertRun({ id: runId, playbookId: PLAYBOOK_ID, playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin', startedAt: '2026-01-01' });
    runs.insertStep({ runId, seq: 1, stepId: 'sub', startedAt: '2026-01-01' });
    runs.writeRunningStepOutput({ runId, seq: 1, output });
  };

  const addChildRun = (runs: Repository, { id, playbookId = PLAYBOOK_ID }: { id: string; playbookId?: string }) =>
    runs.insertRun({ id, playbookId, playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin', startedAt: '2026-01-02' });

  it('finds the step whose output names the child, while the step still runs', () => {
    const { runs } = arrangeRepository();
    addParentStep(runs, { runId: 'parent', output: { childRunId: 'child-1', status: 'running' } });
    addChildRun(runs, { id: 'child-1' });

    expect(runs.parentOf('child-1')).toEqual({ runId: 'parent', seq: 1 });
    expect(runs.stepsOf('parent')[0]).toMatchObject({ status: 'running', output: { childRunId: 'child-1' } });
  });

  it('does not read a child run id that a script printed as text', () => {
    const { runs } = arrangeRepository();
    addParentStep(runs, { runId: 'parent', output: { exitCode: 0, output: '{"childRunId":"child-1"}' } });
    addChildRun(runs, { id: 'child-1' });

    expect(runs.parentOf('child-1')).toBeUndefined();
  });

  it('finds no parent for a child run that does not exist', () => {
    const { runs } = arrangeRepository();
    addParentStep(runs, { runId: 'parent', output: { childRunId: 'child-1', status: 'running' } });

    expect(runs.parentOf('child-1')).toBeUndefined();
  });

  it('finds no parent when the child and the parent belong to different projects', () => {
    const { db, runs } = arrangeRepository();
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Two', 't0')").run();
    db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb-other', 'p2', 'Q', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
    addParentStep(runs, { runId: 'parent', output: { childRunId: 'child-1', status: 'running' } });
    addChildRun(runs, { id: 'child-1', playbookId: 'pb-other' });

    expect(runs.parentOf('child-1')).toBeUndefined();
  });

  describe('journaling the child and the link in one transaction', () => {
    const childRun = { id: 'child-1', playbookId: PLAYBOOK_ID, playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin' as const, startedAt: '2026-01-02' };

    it('writes the link and the child together while the parent step runs', () => {
      const { runs } = arrangeRepository();
      addParentStep(runs, { runId: 'parent', output: {} });

      const outcome = runs.insertRunLinkedToStep({ run: childRun, parentStep: { runId: 'parent', seq: 1 } });

      expect(outcome).toBe('inserted');
      expect(runs.parentOf('child-1')).toEqual({ runId: 'parent', seq: 1 });
      expect(runs.get('child-1')).toMatchObject({ status: 'running' });
    });

    it('inserts no child when the parent run is gone', () => {
      const { runs } = arrangeRepository();

      const outcome = runs.insertRunLinkedToStep({ run: childRun, parentStep: { runId: 'no-such-run', seq: 1 } });

      expect(outcome).toBe('parent_gone');
      expect(runs.get('child-1')).toBeUndefined();
    });

    it('inserts no child when the parent run no longer runs', () => {
      const { runs } = arrangeRepository();
      addParentStep(runs, { runId: 'parent', output: {} });
      runs.settleStep({ runId: 'parent', seq: 1, status: 'failed', endedAt: '2026-01-02' });
      runs.settleRun({ id: 'parent', status: 'failed', endedAt: '2026-01-02' });

      const outcome = runs.insertRunLinkedToStep({ run: childRun, parentStep: { runId: 'parent', seq: 1 } });

      expect(outcome).toBe('parent_gone');
      expect(runs.get('child-1')).toBeUndefined();
    });
  });

  it('does not rewrite the output of a step that is settled', () => {
    const { runs } = arrangeRepository();
    addParentStep(runs, { runId: 'parent', output: { childRunId: 'child-1', status: 'running' } });
    runs.settleStep({ runId: 'parent', seq: 1, status: 'succeeded', output: { childRunId: 'child-1', status: 'succeeded' }, endedAt: '2026-01-02' });

    runs.writeRunningStepOutput({ runId: 'parent', seq: 1, output: { childRunId: 'other', status: 'running' } });

    expect(runs.stepsOf('parent')[0]!.output).toEqual({ childRunId: 'child-1', status: 'succeeded' });
  });

  it('looks only at the most recent steps: a link older than the scan limit is not found', () => {
    const { db, runs } = arrangeRepository();
    addParentStep(runs, { runId: 'parent', output: { childRunId: 'child-1', status: 'running' } });
    addChildRun(runs, { id: 'child-1' });
    runs.insertRun({ id: 'busy', playbookId: PLAYBOOK_ID, playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin', startedAt: '2026-01-03' });
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO playbook_run_steps (run_id, seq, step_id, status, output_json_masked, started_at) SELECT 'busy', i, 'x', 'running', '{}', '2026-01-03' FROM n`).run(PARENT_LOOKUP_SCAN_LIMIT);

    expect(runs.parentOf('child-1')).toBeUndefined();
  });
});
