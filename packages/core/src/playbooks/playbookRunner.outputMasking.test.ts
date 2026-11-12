import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { PlaybookRunner } from './playbookRunner.js';
import { PlaybookRunRepository } from './playbookRunRepository.js';

const directories = createTempDirTracker();
afterEach(() => directories.removeAll());

const SECRET_NAME = 'VALUE';
const canary = `dummy-canary-built-at-runtime-${Date.now()}`;

type Stream = 'stdout' | 'stderr';
type ControlCharacter = { label: string; octalEscape: string; character: string };

const CONTROL_CHARACTERS: ControlCharacter[] = [
  { label: 'CR', octalEscape: '\\015', character: '\r' },
  { label: 'LF', octalEscape: '\\012', character: '\n' },
  { label: 'tab', octalEscape: '\\011', character: '\t' },
  { label: 'NUL', octalEscape: '\\000', character: '\u0000' },
];

/** A run of a script that prints the secret intact, the secret being held by a second cell the walk never reaches: a NUL cannot travel in an environment variable. */
const runPrintingSecret = async ({ secretValue, printed, stream }: { secretValue: string; printed: string; stream: Stream }) => {
  const folder = directories.make('output-masking-');
  const path = join(folder, 'step.sh');
  const redirection = stream === 'stderr' ? ' >&2' : '';
  writeFileSync(path, `#!/bin/sh\nprintf '${printed}'${redirection}\n`);
  chmodSync(path, 0o700);

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
  const runs = new PlaybookRunRepository(db);
  const playbook = {
    id: 'pb1', contentRev: 1, name: 'P', inputs: [], policy: { maxRunsToKeep: 50 },
    flow: { cells: [
      { id: 'prints', kind: 'script', program: 'step.sh', args: [], env: {}, next: [] },
      { id: 'holdsTheSecret', kind: 'script', program: 'step.sh', args: [], env: { HELD: `{{secret:${SECRET_NAME}}}` } },
    ] },
  };
  let runEnded!: () => void;
  const ended = new Promise<void>((resolve) => { runEnded = resolve; });
  const runner = new PlaybookRunner({
    playbooks: { getById: () => playbook } as never,
    approvals: { assertStillApproved: () => ({}), locatePinned: () => ({ path, sha256: 'unused' }) } as never,
    runs, stores: {} as never, secrets: { resolve: async () => secretValue }, clock: () => new Date().toISOString(), newId: () => 'run-1',
    limits: { maxStepExecutions: 10, maxConcurrentRuns: 4, maxRunsNeedingReview: 50 }, observer: { runStarted: () => {}, runEnded },
  });

  await runner.start({ playbookId: 'pb1', inputs: {}, actorKind: 'admin' });
  await ended;
  const persisted = JSON.stringify({ steps: runs.stepsOf('run-1'), run: runs.get('run-1') });
  const output = runs.stepsOf('run-1')[0]?.output as { output: string } | undefined;
  db.close();
  return { persisted, output: output?.output };
};

describe('a secret holding a control character, printed intact', () => {
  const streams: Stream[] = ['stdout', 'stderr'];
  const cases = CONTROL_CHARACTERS.flatMap((control) => streams.map((stream) => ({ ...control, stream })));

  it.each(cases)('is masked whole in the persisted run when it holds a $label in the middle, on $stream', async ({ octalEscape, character, stream }) => {
    const secretValue = `${canary}${character}TAIL-of-the-secret`;
    const printed = `${canary}${octalEscape}TAIL-of-the-secret`;

    const { persisted, output } = await runPrintingSecret({ secretValue, printed, stream });

    expect(persisted).not.toContain(canary);
    expect(persisted).not.toContain('TAIL-of-the-secret');
    expect(output).toBe(`[secret:${SECRET_NAME}]`);
  }, 20_000);

  it('still drops the control characters of the text around a secret', async () => {
    const secretValue = `${canary}\rTAIL-of-the-secret`;
    const printed = `a\\033b\\000c${canary}\\015TAIL-of-the-secret d\\033e`;

    const { output } = await runPrintingSecret({ secretValue, printed, stream: 'stdout' });

    expect(output).toBe(`abc[secret:${SECRET_NAME}] de`);
  }, 20_000);
});
