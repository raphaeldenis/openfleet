import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { PlaybookRunner } from './playbookRunner.js';
import { PlaybookRunRepository } from './playbookRunRepository.js';

const LIMIT = 3;

const playbook = {
  id: 'pb1', contentRev: 1, name: 'P', inputs: [], policy: { maxRunsToKeep: 50 },
  flow: { cells: [{ id: 'only', kind: 'script', program: 'step.sh', args: [], env: {} }] },
};

const arrangeRunnerWithRunsNeedingReview = (count: number) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
  const runs = new PlaybookRunRepository(db);
  for (let index = 0; index < count; index += 1) {
    const id = `review-${index}`;
    runs.insertRun({ id, playbookId: 'pb1', playbookRev: 1, flowSha256: 'x', inputs: {}, actorKind: 'admin', startedAt: `t${index}` });
    runs.settleRun({ id, status: 'needs_review', endedAt: 'now' });
  }
  let runEnded!: () => void;
  const ended = new Promise<void>((resolve) => { runEnded = resolve; });
  const runner = new PlaybookRunner({
    playbooks: { getById: () => playbook } as never,
    approvals: { assertStillApproved: () => ({}), locatePinned: () => { throw new Error('no script in this test'); } } as never,
    runs, stores: {} as never, secrets: { resolve: async () => 'unused' }, clock: () => new Date().toISOString(), newId: () => 'new-run',
    limits: { maxStepExecutions: 10, maxConcurrentRuns: 4, maxRunsNeedingReview: LIMIT }, observer: { runStarted: () => {}, runEnded },
  });
  return { runs, runner, ended };
};

describe('the cap of runs awaiting a review', () => {
  it('refuses a new run with playbook_review_backlog once the cap is reached, and writes nothing', async () => {
    const { runs, runner } = arrangeRunnerWithRunsNeedingReview(LIMIT);

    const refusal = await runner.start({ playbookId: 'pb1', inputs: {}, actorKind: 'admin' }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'playbook_review_backlog' });
    expect(runs.get('new-run')).toBeUndefined();
    expect(runs.countNeedingReview()).toBe(LIMIT);
  });

  it('starts a run while the runs awaiting a review stay under the cap', async () => {
    const { runs, runner, ended } = arrangeRunnerWithRunsNeedingReview(LIMIT - 1);

    await runner.start({ playbookId: 'pb1', inputs: {}, actorKind: 'admin' });
    await ended;

    expect(runs.get('new-run')).toBeDefined();
  });

  it('never deletes a run awaiting a review to make room', async () => {
    const { runs, runner } = arrangeRunnerWithRunsNeedingReview(LIMIT + 2);

    await runner.start({ playbookId: 'pb1', inputs: {}, actorKind: 'admin' }).catch(() => undefined);

    expect(runs.countNeedingReview()).toBe(LIMIT + 2);
  });
});
