import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlaybookRunLauncher } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { until } from '../integrations/manualTimers.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

/**
 * The inputs of a run an agent launched are untrusted: a reference to `inputs.*` (or to `{{item}}` of a loop over an input) is refused where a step output is refused,
 * at run time, since the save does not know who will launch the run. A human (admin_api) and a trigger keep trusting their inputs.
 */
const AGENT: PlaybookRunLauncher = { kind: 'agent', ref: 'session-of-the-agent' };
const ADMIN: PlaybookRunLauncher = { kind: 'admin_api', ref: null };
const TRIGGER: PlaybookRunLauncher = { kind: 'trigger', ref: 'trigger-of-the-test' };
const TRUSTING_LAUNCHERS = [['a human through the admin API', ADMIN], ['a trigger', TRIGGER]] as const;
const SOMETHING_AN_AGENT_TYPED = 'typed-by-the-agent';

const directories = createTempDirTracker();
let fixture: GovernanceFixture;
let scriptRoot = '';
beforeEach(async () => {
  scriptRoot = directories.make('agent-inputs-scripts-');
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot] } });
  writeScript('say.sh', 'printf "%s" "$1"');
});
afterEach(async () => { await fixture.close(); directories.removeAll(); });

const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};
const jsonOf = async <T>(response: Response) => await response.json() as T;
const declaredInputs = ['x', 'host', 'list', 'store'].map((name) => ({ name, type: name === 'list' ? 'json' : 'string', required: false }));
const approvedPlaybook = async (cells: Record<string, unknown>[]) => {
  const created = await fixture.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: `P-${Math.random()}`, inputs: declaredInputs, cells }) });
  expect(created.status).toBe(201);
  const playbook = await jsonOf<{ id: string }>(created);
  const { digest } = await jsonOf<{ digest: string }>(await fixture.api(`/api/playbooks/${playbook.id}/approval`));
  expect((await fixture.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
  return playbook;
};
const statusRow = (runId: string) => fixture.db.prepare('SELECT status, error_code FROM playbook_runs WHERE id = ?').get(runId) as { status: string; error_code: string | null };
const runAs = async (launchedBy: PlaybookRunLauncher, playbookId: string, inputs: Record<string, unknown>) => {
  const started = await fixture.daemon.playbookRunner.start({ playbookId, inputs, actorKind: 'admin', launchedBy });
  await until(() => statusRow(started.id).status !== 'running');
  return { id: started.id, status: statusRow(started.id).status, errorCode: statusRow(started.id).error_code };
};
const stepsOfRun = (runId: string) => fixture.db.prepare('SELECT step_id, status, error_code, output_json_masked FROM playbook_run_steps WHERE run_id = ? ORDER BY seq').all(runId) as { step_id: string; status: string; error_code: string | null; output_json_masked: string | null }[];
const stepErrorCodesOf = (runId: string) => stepsOfRun(runId).map((step) => step.error_code);
const scriptCell = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'script', program: 'say.sh', env: {}, ...extra });
const httpCell = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'http', method: 'GET', url: 'https://example.invalid/', ...extra });

const PLACES_THAT_STEER: [string, () => Record<string, unknown>[], Record<string, unknown>][] = [
  ['an argument of a script', () => [scriptCell('say', { args: ['{{inputs.x}}'] })], { x: SOMETHING_AN_AGENT_TYPED }],
  ['a value of the environment of a script', () => [scriptCell('say', { args: ['fixed'], env: { FROM_INPUT: '{{inputs.x}}' } })], { x: SOMETHING_AN_AGENT_TYPED }],
  ['the authority of an http url', () => [httpCell('call', { url: 'https://{{inputs.host}}/' })], { host: 'example.invalid' }],
  ['a header', () => [httpCell('call', { headers: { 'X-From': '{{inputs.x}}' } })], { x: SOMETHING_AN_AGENT_TYPED }],
  ['the token of the authentication', () => [httpCell('call', { auth: { type: 'bearer', token: '{{inputs.x}}' } })], { x: SOMETHING_AN_AGENT_TYPED }],
  ['the identifier of a store', () => [{ id: 'read', kind: 'readFromStore', storeID: '{{inputs.store}}', columns: [] }], { store: 'some-store' }],
  ['the {{item}} of a loop over an input', () => [scriptCell('first', { args: ['start'] }), scriptCell('each', { args: ['{{item}}'] })], { list: [SOMETHING_AN_AGENT_TYPED] }],
];
const withLoopEdge = (cells: Record<string, unknown>[]) => (cells.length === 2 ? [{ ...cells[0], next: [{ to: 'each', forEach: 'inputs.list' }] }, cells[1]!] : cells);

describe('the inputs of a run an agent launched are untrusted', () => {
  it.each(PLACES_THAT_STEER)('refuses a reference to an input in %s, with untrusted_reference', async (_place, cellsOf, inputs) => {
    const playbook = await approvedPlaybook(withLoopEdge(cellsOf()));

    const run = await runAs(AGENT, playbook.id, inputs);

    expect(run.status).toBe('failed');
    expect(stepErrorCodesOf(run.id)).toContain('untrusted_reference');
    expect(JSON.stringify(stepsOfRun(run.id))).not.toContain(SOMETHING_AN_AGENT_TYPED);
  });

  it.each(PLACES_THAT_STEER)('does not refuse a reference to an input in %s when a human or a trigger launched the run', async (_place, cellsOf, inputs) => {
    const playbook = await approvedPlaybook(withLoopEdge(cellsOf()));

    for (const [, launcher] of TRUSTING_LAUNCHERS) {
      const run = await runAs(launcher, playbook.id, inputs);

      expect([run.errorCode, ...stepErrorCodesOf(run.id)], `${launcher.kind}`).not.toContain('untrusted_reference');
    }
  });

  it('lets a human and a trigger run a script that takes an input as an argument, to the end', async () => {
    const playbook = await approvedPlaybook([scriptCell('say', { args: ['{{inputs.x}}'] })]);

    for (const [, launcher] of TRUSTING_LAUNCHERS) {
      const run = await runAs(launcher, playbook.id, { x: 'typed-by-a-human' });

      expect(run).toMatchObject({ status: 'succeeded', errorCode: null });
      expect(stepsOfRun(run.id)[0]!.output_json_masked).toContain('typed-by-a-human');
    }
  });

  it('refuses the input an agent passes to a child through the inputs of a subPlaybook cell', async () => {
    const child = await approvedPlaybook([scriptCell('say', { args: ['fixed'] })]);
    const parent = await approvedPlaybook([{ id: 'sub', kind: 'subPlaybook', playbookId: child.id, inputs: { x: '{{inputs.x}}' } }]);

    const agentRun = await runAs(AGENT, parent.id, { x: SOMETHING_AN_AGENT_TYPED });
    const humanRun = await runAs(ADMIN, parent.id, { x: 'typed-by-a-human' });

    expect(agentRun).toMatchObject({ status: 'failed', errorCode: 'untrusted_reference' });
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs WHERE playbook_id = ? AND launched_by_kind = ?').get(child.id, 'agent')).toEqual({ n: 0 });
    expect(humanRun.status).toBe('succeeded');
  });

  it('keeps the child of an agent run untrusting its own inputs, whatever the parent wrote in them', async () => {
    const child = await approvedPlaybook([scriptCell('say', { args: ['{{inputs.x}}'] })]);
    const parent = await approvedPlaybook([{ id: 'sub', kind: 'subPlaybook', playbookId: child.id, inputs: { x: 'a literal of the playbook' } }]);

    const agentRun = await runAs(AGENT, parent.id, {});
    const humanRun = await runAs(ADMIN, parent.id, {});

    const childRunOfTheAgent = fixture.db.prepare('SELECT status, error_code, launched_by_kind, launched_by_ref FROM playbook_runs WHERE playbook_id = ? ORDER BY started_at, rowid').all(child.id) as Record<string, unknown>[];
    expect(childRunOfTheAgent[0]).toMatchObject({ status: 'failed', error_code: 'untrusted_reference', launched_by_kind: 'agent', launched_by_ref: AGENT.ref });
    expect(agentRun).toMatchObject({ status: 'failed', errorCode: 'sub_playbook_failed' });
    expect(humanRun.status).toBe('succeeded');
  });

  it('still lets an agent input into the places that hold data: the body of an http request and the text put to a human', async () => {
    const asked = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Is {{inputs.x}} right?' }]);
    const posted = await approvedPlaybook([httpCell('call', { method: 'POST', body: '{{inputs.x}}' })]);

    const askRun = await runAs(AGENT, asked.id, { x: SOMETHING_AN_AGENT_TYPED });
    const postRun = await runAs(AGENT, posted.id, { x: SOMETHING_AN_AGENT_TYPED });

    expect(askRun).toMatchObject({ status: 'waiting_manual' });
    expect(postRun.errorCode).not.toBe('untrusted_reference');
  });
});
