import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { recentLogLines } from '../logger.js';
import { PlaybookRunner } from './playbookRunner.js';
import { PlaybookRunRepository } from './playbookRunRepository.js';

const SECRET_NAME = 'API_KEY';
const secretValue = `dummy-secret-built-at-runtime-${Date.now()}`;

const playbook = {
  id: 'pb1', contentRev: 1, name: 'P', inputs: [], policy: { maxRunsToKeep: 50 },
  flow: { cells: [{ id: 'only', kind: 'script', program: 'step.sh', args: [], env: { [SECRET_NAME]: `{{secret:${SECRET_NAME}}}` } }] },
};

const arrangeRunnerWhoseScriptLookupFails = (failure: () => never) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
  const runs = new PlaybookRunRepository(db);
  let runEnded!: () => void;
  const ended = new Promise<void>((resolve) => { runEnded = resolve; });
  const runner = new PlaybookRunner({
    playbooks: { getById: () => playbook } as never,
    approvals: { assertStillApproved: () => ({}), locatePinned: failure },
    runs, secrets: { resolve: async () => secretValue }, clock: () => new Date().toISOString(), newId: () => 'run-1',
    limits: { maxStepExecutions: 10, maxConcurrentRuns: 4 }, observer: { runStarted: () => {}, runEnded },
  });
  return { db, runs, runner, ended };
};

describe('an unexpected error during a step', () => {
  it('fails the step with internal_error and logs it with the value of the secret masked', async () => {
    const { runs, runner, ended } = arrangeRunnerWhoseScriptLookupFails(() => { throw new Error(`lookup failed for ${secretValue}`); });

    await runner.start({ playbookId: 'pb1', inputs: {}, actorKind: 'admin' });
    await ended;

    expect(runs.get('run-1')).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    const unexpectedFailures = recentLogLines().filter((line) => line.includes('a playbook step failed unexpectedly'));
    expect(unexpectedFailures.length).toBeGreaterThan(0);
    expect(recentLogLines().join('\n')).not.toContain(secretValue);
  });

  it('masks a secret thrown as a plain string', async () => {
    const { runner, ended } = arrangeRunnerWhoseScriptLookupFails(() => { throw `lookup failed for ${secretValue}`; });

    await runner.start({ playbookId: 'pb1', inputs: {}, actorKind: 'admin' });
    await ended;

    expect(recentLogLines().join('\n')).not.toContain(secretValue);
  });
});
