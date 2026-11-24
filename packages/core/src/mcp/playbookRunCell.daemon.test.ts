import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { until } from '../integrations/manualTimers.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

/*
 * Guards of run_playbook_cell, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. one cell, no edge          `soloCellId` in `walk`                 -> 'runs the named cell alone ...'
 *  2. no human gate skipped      `hasManualCell` in the solo check      -> 'refuses a playbook that holds a manual cell ...'
 *  3. no step output             `REFERENCES_A_STEP` in the solo check  -> 'refuses a cell that reads the output of another step ...'
 *  4. unknown cell               `playbook_cell_not_found`              -> 'refuses a cell the playbook does not hold'
 *  5. untrusted inputs           `launchedBy` agent                     -> 'treats the inputs as untrusted data ...'
 *  6. the checks of a start      beginRun                               -> 'is refused like run_playbook ...' (one test per guard: approval, lock, capacity)
 *  7. entry cell only            `isTheEntryCell`                       -> 'refuses a cell that is not the entry cell ...', 'refuses a target behind an upstream condition ...', '... the fallback target ...', '... a forEach branch which may be empty'
 */
type Client = Awaited<ReturnType<GovernanceFixture['connect']>>;

const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let lead: Client;
let scriptRoot = '';
let markers = '';

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  directories.removeAll();
});

const boot = async (limits: { maxConcurrentRuns?: number } = {}) => {
  scriptRoot = directories.make('cell-scripts-');
  markers = directories.make('cell-markers-');
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], ...limits } });
  lead = await fixture.connect(fixture.lead.id);
  writeScript('mark.sh', `touch ${markers}/"$1"`);
  writeScript('hold.sh', `while [ ! -e ${join(markers, 'go')} ]; do sleep 0.05; done`);
};
const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text, json: result.isError === true ? undefined : (JSON.parse(text) as Record<string, any>) };
};
const jsonOf = async <T>(response: Response) => await response.json() as T;
const markCell = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'script', program: 'mark.sh', args: [id], env: {}, ...extra });
const createPlaybook = async (cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  jsonOf<{ id: string }>(await fixture!.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: `P-${randomUUID()}`, cells, ...extra }) }));
const approve = async (playbookId: string) => {
  const { digest } = await jsonOf<{ digest: string }>(await fixture!.api(`/api/playbooks/${playbookId}/approval`));
  expect((await fixture!.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
};
const approvedPlaybook = async (cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const playbook = await createPlaybook(cells, extra);
  await approve(playbook.id);
  return playbook;
};
const runRows = () => fixture!.db.prepare('SELECT id, status, error_code, launched_by_kind FROM playbook_runs').all() as { id: string; status: string; error_code: string | null; launched_by_kind: string }[];
const stepRows = (runId: string) => fixture!.db.prepare('SELECT step_id, status, error_code FROM playbook_run_steps WHERE run_id = ? ORDER BY seq').all(runId) as { step_id: string; status: string; error_code: string | null }[];

describe('run_playbook_cell runs one cell of an approved playbook', () => {
  it('runs the entry cell alone: one journaled step, the cells after it never start', async () => {
    await boot();
    const playbook = await approvedPlaybook([markCell('first'), markCell('second'), markCell('third')]);

    const started = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(started.isError, started.text).toBe(false);
    const runId = started.json!.run.id as string;
    await until(() => runRows().find((run) => run.id === runId)?.status === 'succeeded');
    expect(stepRows(runId)).toEqual([{ step_id: 'first', status: 'succeeded', error_code: null }]);
    expect(existsSync(join(markers, 'first'))).toBe(true);
    expect([existsSync(join(markers, 'second')), existsSync(join(markers, 'third'))]).toEqual([false, false]);
    expect(runRows().find((run) => run.id === runId)?.launched_by_kind).toBe('agent');
  });

  it('refuses a cell that is not the entry cell, whatever the edges that lead to it: the solo run is not a general single-cell runner', async () => {
    await boot();
    const playbook = await approvedPlaybook([markCell('first'), markCell('second')]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'second' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'second'))).toBe(false);
  });

  it('refuses a target behind an upstream condition, reached only through a cell with a plain edge', async () => {
    await boot();
    const playbook = await approvedPlaybook([
      markCell('first', { next: [{ to: 'conditional', when: [{ lhs: 'inputs.go', op: 'eq', rhs: 'yes' }] }] }),
      markCell('conditional', { next: [{ to: 'indirect' }] }),
      markCell('indirect'),
    ], { inputs: [{ name: 'go', type: 'string', required: false }] });

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'indirect' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'indirect'))).toBe(false);
  });

  it('refuses the fallback target of a condition: its own incoming edge is plain, but it is taken only when the first edge does not match', async () => {
    await boot();
    const playbook = await approvedPlaybook([
      markCell('first', { next: [{ to: 'primary', when: [{ lhs: 'inputs.go', op: 'eq', rhs: 'yes' }] }, { to: 'fallback' }] }),
      markCell('primary'),
      markCell('fallback'),
    ], { inputs: [{ name: 'go', type: 'string', required: false }] });

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'fallback' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'fallback'))).toBe(false);
  });

  it('refuses a target that follows a forEach branch which may be empty', async () => {
    await boot();
    const playbook = await approvedPlaybook([
      markCell('first', { next: [{ to: 'each', forEach: 'inputs.names' }] }),
      markCell('each', { args: ['{{item}}'], next: [{ to: 'after' }] }),
      markCell('after'),
    ], { inputs: [{ name: 'names', type: 'json', required: false }] });

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'after' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'after'))).toBe(false);
  });


  it('refuses a playbook that holds a manual cell: no cell of it runs alone, so no human gate is skipped', async () => {
    await boot();
    const playbook = await approvedPlaybook([{ id: 'gate', kind: 'manual', prompt: 'Deploy?' }, markCell('deploy')]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'deploy' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'deploy'))).toBe(false);
  });

  it('refuses a cell that reads the output of another step: the output is not there, and nothing is written', async () => {
    await boot();
    const playbook = await approvedPlaybook([{ id: 'first', kind: 'waitFor', predicate: [{ lhs: 'steps.ghost.exitCode', op: 'eq', rhs: 0 }] }]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
  });

  it.each([
    ['the whole steps dictionary', 'steps'],
    ['the whole output of another step, with no field', 'steps.ghost'],
  ])('refuses a waitFor condition that reads %s', async (_name, lhs) => {
    await boot();
    const playbook = await approvedPlaybook([{ id: 'first', kind: 'waitFor', predicate: [{ lhs, op: 'eq', rhs: 'x' }] }]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
  });

  it('refuses a cell whose retry predicate reads the output of another step', async () => {
    await boot();
    const retry = { maxAttempts: 2, backoffMs: 0, until: [{ lhs: 'steps.ghost.exitCode', op: 'eq', rhs: 0 }] };
    const playbook = await approvedPlaybook([markCell('first', { retry })]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
  });

  it.each([
    ['the whole steps dictionary', 'steps'],
    ['the whole output of another step, with no field', 'steps.ghost'],
  ])('refuses a cell whose retry predicate reads %s: only the output of its own attempt is exempt', async (_name, lhs) => {
    await boot();
    const retry = { maxAttempts: 2, backoffMs: 0, until: [{ lhs, op: 'eq', rhs: 'x' }] };
    const playbook = await approvedPlaybook([markCell('first', { retry })]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
  });

  it('runs a cell whose retry predicate reads the output of its own attempt', async () => {
    await boot();
    const retry = { maxAttempts: 2, backoffMs: 0, until: [{ lhs: 'steps.first.exitCode', op: 'eq', rhs: 0 }] };
    const playbook = await approvedPlaybook([markCell('first', { retry }), markCell('second')]);

    const started = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(started.isError, started.text).toBe(false);
    const runId = started.json!.run.id as string;
    await until(() => runRows().find((run) => run.id === runId)?.status === 'succeeded');
    expect(stepRows(runId)).toEqual([{ step_id: 'first', status: 'succeeded', error_code: null }]);
  });

  it('runs a cell whose text only contains the letters "steps." and reads no step', async () => {
    await boot();
    const playbook = await approvedPlaybook([markCell('first', { args: ['steps.txt'] }), markCell('second')]);

    const started = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first' });

    expect(started.isError, started.text).toBe(false);
    const runId = started.json!.run.id as string;
    await until(() => runRows().find((run) => run.id === runId)?.status === 'succeeded');
    expect(existsSync(join(markers, 'steps.txt'))).toBe(true);
  });

  it('refuses a cell the playbook does not hold', async () => {
    await boot();
    const playbook = await approvedPlaybook([markCell('first')]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'ghost' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_cell_not_found');
    expect(runRows()).toEqual([]);
  });

  it('treats the inputs as untrusted data: a script argument built from an input fails the step with untrusted_reference', async () => {
    await boot();
    const playbook = await approvedPlaybook([markCell('first', { args: ['{{inputs.name}}'] })], { inputs: [{ name: 'name', type: 'string', required: true }] });

    const started = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first', inputs: { name: 'x' } });

    expect(started.isError, started.text).toBe(false);
    const runId = started.json!.run.id as string;
    await until(() => runRows().find((run) => run.id === runId)?.status === 'failed');
    expect(stepRows(runId)).toEqual([{ step_id: 'first', status: 'failed', error_code: 'untrusted_reference' }]);
    expect(existsSync(join(markers, 'x'))).toBe(false);
  });

  it('records the call in the activity log without the text of the inputs', async () => {
    await boot();
    const hostile = `hostile-text-${randomUUID()}`;
    const hostileNumber = 987654321;
    const playbook = await approvedPlaybook([markCell('first')], { inputs: [{ name: 'name', type: 'string', required: true }, { name: 'count', type: 'number', required: true }] });

    const started = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'first', inputs: { name: hostile, count: hostileNumber } });

    expect(started.isError, started.text).toBe(false);
    const activity = JSON.stringify(fixture!.db.prepare('SELECT * FROM activity_log').all());
    expect(activity).toContain('run_playbook_cell');
    expect(activity).not.toContain(hostile);
    expect(activity).not.toContain(String(hostileNumber));
  });

  it('is refused like run_playbook when the playbook is not approved', async () => {
    await boot();
    const unapproved = await createPlaybook([markCell('first')]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: unapproved.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_unapproved');
    expect(runRows()).toEqual([]);
  });

  it('is refused like run_playbook when the playbook is locked against agents', async () => {
    await boot();
    const locked = await approvedPlaybook([markCell('first')]);
    fixture!.db.prepare('UPDATE playbooks SET agent_locked = 1 WHERE id = ?').run(locked.id);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: locked.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_locked');
    expect(runRows()).toEqual([]);
  });

  it('is refused like run_playbook when the capacity of runs at once is reached', async () => {
    await boot({ maxConcurrentRuns: 1 });
    const holding = await approvedPlaybook([{ id: 'hold', kind: 'script', program: 'hold.sh', args: [], env: {} }]);
    const other = await approvedPlaybook([markCell('first')]);
    expect((await tool(lead, 'run_playbook', { playbook: holding.id })).isError).toBe(false);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: other.id, step_id: 'first' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_run_busy');
    writeFileSync(join(markers, 'go'), '');
  });

  it('refuses a cell that an incoming edge guards with a condition: running it alone would skip the condition the approval covered', async () => {
    await boot();
    const playbook = await approvedPlaybook([
      markCell('first', { next: [{ to: 'guarded', when: [{ lhs: 'inputs.go', op: 'eq', rhs: 'yes' }] }] }),
      markCell('guarded'),
    ], { inputs: [{ name: 'go', type: 'string', required: false }] });

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'guarded' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'guarded'))).toBe(false);
  });

  it('refuses a cell that an incoming forEach edge iterates: running it alone would skip the iteration the approval covered', async () => {
    await boot();
    const playbook = await approvedPlaybook([
      markCell('first', { next: [{ to: 'each', forEach: 'inputs.names' }] }),
      markCell('each', { args: ['{{item}}'] }),
    ], { inputs: [{ name: 'names', type: 'json', required: false }] });

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'each' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
  });

  it('refuses a cell that only a plain edge leads to: only the entry cell runs alone', async () => {
    await boot();
    const playbook = await approvedPlaybook([markCell('first', { next: [{ to: 'plain' }] }), markCell('plain')]);

    const refused = await tool(lead, 'run_playbook_cell', { playbook: playbook.id, step_id: 'plain' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('playbook_not_runnable');
    expect(runRows()).toEqual([]);
    expect(existsSync(join(markers, 'plain'))).toBe(false);
  });
});
