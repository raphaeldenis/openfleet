import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { PlaybookRunRepository } from './playbookRunRepository.js';

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
