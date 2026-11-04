import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { PlaybookRepository } from './playbookRepository.js';

type RunView = {
  id: string; playbookId: string; status: string; errorCode: string | null; inputs: Record<string, unknown>;
  steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: { exitCode?: number; output?: string } | null }[];
};

const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let scriptRoot = '';
let markers = '';
let secretStore: InMemorySecretStore;
afterEach(async () => { await fixture?.close(); fixture = undefined; directories.removeAll(); });

const SECRET_NAME = 'API_KEY';
const secretValue = `canary-${randomUUID()}`;
const secretValueInBase64 = Buffer.from(secretValue).toString('base64');

const boot = async (playbooks: { maxStepExecutions?: number; maxConcurrentRuns?: number } = {}) => {
  scriptRoot = directories.make('playbook-scripts-');
  markers = directories.make('playbook-markers-');
  secretStore = createInMemorySecretStore();
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], ...playbooks }, secrets: { store: secretStore } });
  return fixture;
};

const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
};
const marker = (name: string) => join(markers, name);
const jsonOf = async <T>(response: Response) => await response.json() as T;
const scriptCell = (id: string, program: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'script', program, ...extra });

const createPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  jsonOf<{ id: string; contentRev: number }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells, ...extra }) }));
const approvalDigestOf = async (f: GovernanceFixture, playbookId: string) => (await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbookId}/approval`))).digest;
const approve = async (f: GovernanceFixture, playbookId: string) => f.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest: await approvalDigestOf(f, playbookId) }) });
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const playbook = await createPlaybook(f, cells, extra);
  const approval = await approve(f, playbook.id);
  expect(approval.status).toBe(200);
  return playbook;
};
const startRun = (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) =>
  f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) });
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (what: string, isDone: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await isDone())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(25);
  }
};
const runToTheEnd = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const started = await startRun(f, playbookId, inputs);
  expect(started.status).toBe(202);
  const { id } = await jsonOf<RunView>(started);
  await waitUntil('the run to end', async () => (await viewOfRun(f, id)).status !== 'running');
  return viewOfRun(f, id);
};
const runCount = (f: GovernanceFixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n;
const everythingPersistedByRuns = (f: GovernanceFixture) =>
  JSON.stringify(['playbook_runs', 'playbook_run_steps', 'activity_log'].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));

describe('the playbook run routes are behind the admin token', () => {
  it.each([
    ['GET', '/api/playbooks/x/approval'],
    ['POST', '/api/playbooks/x/approve'],
    ['POST', '/api/playbooks/x/run'],
    ['GET', '/api/playbook-runs/x'],
    ['GET', '/api/playbook-runs?playbookId=x'],
  ])('answers 401 to %s %s with no token and with the MCP token of a session', async (method, path) => {
    const f = await boot();
    const mcpToken = (f.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(f.lead.id) as { mcp_token: string }).mcp_token;
    const send = (authorization?: string) => fetch(`${f.daemon.server.url}${path}`, { method, body: method === 'GET' ? undefined : '{}', headers: { 'content-type': 'application/json', ...(authorization && { authorization }) } });

    const withoutToken = await send();
    const withSessionToken = await send(`Bearer ${mcpToken}`);

    expect([withoutToken.status, withSessionToken.status]).toEqual([401, 401]);
  });
});

describe('what a human approves is exactly what runs', () => {
  it('refuses to run a playbook no human approved, and writes no run', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createPlaybook(f, [scriptCell('say', 'hello.sh')]);

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_unapproved' });
    expect(runCount(f)).toBe(0);
  });

  it('refuses to run a playbook an agent authored through MCP until a human approves it', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const lead = await f.connect(f.lead.id);
    const created = await lead.callTool({ name: 'create_playbook', arguments: { name: 'Agent made' } });
    const { id } = JSON.parse((created.content as { text: string }[])[0]!.text) as { id: string };
    await lead.callTool({ name: 'add_playbook_cell', arguments: { playbook: id, kind: 'script', args: { program: 'hello.sh' }, expected_rev: 1 } });

    const beforeApproval = await startRun(f, id);
    const approval = await approve(f, id);
    const afterApproval = await runToTheEnd(f, id);

    expect(beforeApproval.status).toBe(409);
    expect(await beforeApproval.json()).toMatchObject({ error: 'playbook_unapproved' });
    expect(approval.status).toBe(200);
    expect(afterApproval.status).toBe('succeeded');
  });

  it('refuses an approval whose digest is not the digest of the playbook as it stands', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createPlaybook(f, [scriptCell('say', 'hello.sh')]);
    const digestRead = await approvalDigestOf(f, playbook.id);
    await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, name: 'Renamed after the review' }) });

    const refused = await f.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest: digestRead }) });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'approval_digest_mismatch' });
    expect((await startRun(f, playbook.id)).status).toBe(409);
  });

  it('clears the approval when the playbook is edited: the edited playbook is refused again', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createApprovedPlaybook(f, [scriptCell('say', 'hello.sh')]);
    await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, cells: [scriptCell('say', 'hello.sh', { args: ['--other'] })] }) });

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_unapproved' });
  });

  it('refuses a playbook that holds an approved digest but no pinned scripts', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createPlaybook(f, [scriptCell('say', 'hello.sh')]);
    f.db.prepare("UPDATE playbooks SET approved_digest = 'digest', approved_by = 'human', approved_at = 'now' WHERE id = ?").run(playbook.id);

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_unapproved' });
  });

  it('refuses a playbook whose stored content no longer matches its approved digest', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createApprovedPlaybook(f, [scriptCell('say', 'hello.sh')]);
    f.db.prepare('UPDATE playbooks SET flow_json = ? WHERE id = ?').run(JSON.stringify({ cells: [scriptCell('say', 'hello.sh', { args: ['--tampered'] })] }), playbook.id);

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_unapproved' });
  });

  it('answers script_changed at launch when a script file changed after the approval, and writes no run', async () => {
    const f = await boot();
    const script = writeScript('hello.sh', 'printf hello');
    const playbook = await createApprovedPlaybook(f, [scriptCell('say', 'hello.sh')]);
    writeFileSync(script, '#!/bin/sh\nprintf changed\n');

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'script_changed' });
    expect(runCount(f)).toBe(0);
  });

  it('fails the run with script_changed, and never starts the step, when an earlier step rewrote the script of a later step', async () => {
    const f = await boot();
    writeScript('second.sh', `touch ${marker('second-ran')}`);
    writeScript('first.sh', `printf '#!/bin/sh\\ntouch ${marker('second-ran-after-rewrite')}\\n' > ${join(scriptRoot, 'second.sh')}`);
    const playbook = await createApprovedPlaybook(f, [scriptCell('first', 'first.sh'), scriptCell('second', 'second.sh')]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('script_changed');
    expect(run.steps.map((step) => [step.stepId, step.status, step.errorCode])).toEqual([['first', 'succeeded', null], ['second', 'failed', 'script_changed']]);
    expect(existsSync(marker('second-ran-after-rewrite'))).toBe(false);
    expect(existsSync(marker('second-ran'))).toBe(false);
  });

  it('refuses to approve a program that is not under a script root, through a path, an absolute path or a symlink', async () => {
    const f = await boot();
    const outside = directories.make('playbook-outside-');
    const outsideScript = join(outside, 'outside.sh');
    writeFileSync(outsideScript, '#!/bin/sh\nprintf outside\n');
    chmodSync(outsideScript, 0o700);
    symlinkSync(outsideScript, join(scriptRoot, 'link.sh'));
    mkdirSync(join(scriptRoot, 'sub'));

    const programs = ['../outside.sh', outsideScript, 'link.sh', 'missing.sh'];
    const answers = await Promise.all(programs.map(async (program) => {
      const playbook = await createPlaybook(f, [scriptCell('only', program)]);
      return f.api(`/api/playbooks/${playbook.id}/approval`);
    }));

    expect(answers.map((answer) => answer.status)).toEqual([409, 409, 409, 409]);
    expect((await Promise.all(answers.map((answer) => answer.json()))).map((body) => (body as { error: string }).error)).toEqual(Array(4).fill('script_not_allowed'));
  });

  it('refuses to approve a script that another user could rewrite (group or world writable)', async () => {
    const f = await boot();
    const script = writeScript('open.sh', 'printf open');
    chmodSync(script, 0o722);
    const playbook = await createPlaybook(f, [scriptCell('only', 'open.sh')]);

    const answer = await f.api(`/api/playbooks/${playbook.id}/approval`);

    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ error: 'script_not_allowed' });
  });

  it('refuses a program written with a token, which no approval can pin', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createPlaybook(f, [scriptCell('only', '{{inputs.which}}')], { inputs: [{ name: 'which', type: 'string' }] });

    const answer = await f.api(`/api/playbooks/${playbook.id}/approval`);

    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ error: 'script_not_allowed' });
  });

  it('refuses to run a cell kind this runner does not execute, and writes no run', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createPlaybook(f, [scriptCell('say', 'hello.sh'), { id: 'ask', kind: 'manual', prompt: 'Check it' }]);
    await approve(f, playbook.id);

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_not_runnable' });
    expect(runCount(f)).toBe(0);
  });
});

describe('a script run is journaled before it runs and answers what it printed', () => {
  it('shows the step as running while its script runs, then succeeded with its output', async () => {
    const f = await boot();
    writeScript('slow.sh', `touch ${marker('started')}\nwhile [ ! -f ${marker('go')} ]; do sleep 0.05; done\nprintf 'done\\n'`);
    const playbook = await createApprovedPlaybook(f, [scriptCell('slow', 'slow.sh')]);

    const { id } = await jsonOf<RunView>(await startRun(f, playbook.id));
    await waitUntil('the script to start', () => existsSync(marker('started')));
    const whileRunning = await viewOfRun(f, id);
    writeFileSync(marker('go'), '');
    await waitUntil('the run to end', async () => (await viewOfRun(f, id)).status !== 'running');
    const afterwards = await viewOfRun(f, id);

    expect([whileRunning.status, whileRunning.steps.map((step) => [step.stepId, step.status])]).toEqual(['running', [['slow', 'running']]]);
    expect(afterwards.status).toBe('succeeded');
    expect(afterwards.steps[0]).toMatchObject({ seq: 1, status: 'succeeded', output: { exitCode: 0, output: 'done\n' } });
  });

  it('fails the run with script_failed and keeps what a script printed when it exits non-zero', async () => {
    const f = await boot();
    writeScript('fail.sh', "printf 'boom\\n'\nexit 3");
    const playbook = await createApprovedPlaybook(f, [scriptCell('fail', 'fail.sh'), scriptCell('never', 'fail.sh')]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'script_failed' });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'script_failed', output: { exitCode: 3, output: 'boom\n' } });
  });

  it('kills a script that outlasts the timeout of its cell and fails the run with script_timeout', async () => {
    const f = await boot();
    writeScript('hang.sh', `printf '%s' "$$" > ${marker('pid')}\nsleep 30`);
    const playbook = await createApprovedPlaybook(f, [scriptCell('hang', 'hang.sh', { timeoutSeconds: 1 })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'script_timeout' });
    const pid = Number(readFileSync(marker('pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 25_000);

  it('passes the resolved arguments and inputs to the script, and no variable of the daemon', async () => {
    const f = await boot();
    process.env.PLAYBOOK_PARENT_CANARY = 'parent-canary';
    writeScript('show.sh', 'printf "%s|%s|%s|%s" "$1" "$2" "$GREETING" "${PLAYBOOK_PARENT_CANARY:-absent}"');
    const playbook = await createApprovedPlaybook(f, [scriptCell('show', 'show.sh', { args: ['{{inputs.who}}', 'literal'], env: { GREETING: 'hi {{inputs.who}}' } })], { inputs: [{ name: 'who', type: 'string', required: true }] });

    const run = await runToTheEnd(f, playbook.id, { who: 'Ada' });
    delete process.env.PLAYBOOK_PARENT_CANARY;

    expect(run.steps[0]?.output?.output).toBe('Ada|literal|hi Ada|absent');
  });

  it('refuses a run that lacks a required input, or names an input the playbook does not declare, and writes no run', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createApprovedPlaybook(f, [scriptCell('say', 'hello.sh')], { inputs: [{ name: 'who', type: 'string', required: true }] });

    const missing = await startRun(f, playbook.id, {});
    const unknown = await startRun(f, playbook.id, { who: 'Ada', extra: 'x' });
    const wrongType = await startRun(f, playbook.id, { who: 42 });

    expect([missing.status, unknown.status, wrongType.status]).toEqual([400, 400, 400]);
    expect(runCount(f)).toBe(0);
  });

  it('follows the first edge whose condition holds on the output of the step', async () => {
    const f = await boot();
    writeScript('exit-zero.sh', 'printf ok');
    writeScript('on-ok.sh', `touch ${marker('on-ok')}`);
    writeScript('on-other.sh', `touch ${marker('on-other')}`);
    const playbook = await createApprovedPlaybook(f, [
      scriptCell('probe', 'exit-zero.sh', { next: [{ to: 'other', when: [{ lhs: 'steps.probe.output', op: 'eq', rhs: 'nope', join: 'and' }] }, { to: 'ok', when: [{ lhs: 'steps.probe.output', op: 'eq', rhs: 'ok', join: 'and' }] }] }),
      scriptCell('other', 'on-other.sh', { next: [] }),
      scriptCell('ok', 'on-ok.sh', { next: [] }),
    ]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.steps.map((step) => step.stepId)).toEqual(['probe', 'ok']);
    expect([existsSync(marker('on-ok')), existsSync(marker('on-other'))]).toEqual([true, false]);
  });
});

describe('the value of a secret never reaches what is stored or answered', () => {
  const printsTheSecret = `printf 'status: Done\\n'\nprintf 'key=%s\\n' "$${SECRET_NAME}"\nprintf 'b64=%s\\n' "$(printf %s "$${SECRET_NAME}" | base64)"`;

  const approvedLeakingPlaybook = async (f: GovernanceFixture) => {
    writeScript('leak.sh', printsTheSecret);
    const playbook = await createApprovedPlaybook(f, [scriptCell('leak', 'leak.sh', { env: { [SECRET_NAME]: `{{secret:${SECRET_NAME}}}` } })]);
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);
    return playbook;
  };

  it('replaces the secret, in its plain and base64 forms, by its marker and leaves the rest of the output readable', async () => {
    const f = await boot();
    const playbook = await approvedLeakingPlaybook(f);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output?.output).toMatch(new RegExp(`^status: Done\\nkey=\\[secret:${SECRET_NAME}\\]\\nb64=\\[secret:${SECRET_NAME}\\]=*\\n$`));
  });

  it('leaves no trace of the value in the rows of the runs, the activity log or the answers of the daemon', async () => {
    const f = await boot();
    const playbook = await approvedLeakingPlaybook(f);

    const { id } = await runToTheEnd(f, playbook.id);
    const answers = [await (await f.api(`/api/playbook-runs/${id}`)).text(), await (await f.api(`/api/playbook-runs?playbookId=${playbook.id}`)).text()].join('');

    for (const trace of [everythingPersistedByRuns(f), answers]) {
      expect(trace).not.toContain(secretValue);
      expect(trace).not.toContain(secretValueInBase64);
    }
  });

  it('masks a secret that arrives as an input before the inputs are stored', async () => {
    const f = await boot();
    const playbook = await approvedLeakingPlaybook(f);
    await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, inputs: [{ name: 'note', type: 'string' }], cells: [scriptCell('leak', 'leak.sh', { env: { [SECRET_NAME]: `{{secret:${SECRET_NAME}}}` } })] }) });
    await approve(f, playbook.id);

    const run = await runToTheEnd(f, playbook.id, { note: `pasted ${secretValue} by mistake` });

    expect(run.inputs).toEqual({ note: `pasted [secret:${SECRET_NAME}] by mistake` });
    expect(everythingPersistedByRuns(f)).not.toContain(secretValue);
  });

  it('refuses to run, and writes no run, when this device holds no value for a secret the playbook uses', async () => {
    const f = await boot();
    writeScript('leak.sh', printsTheSecret);
    const playbook = await createApprovedPlaybook(f, [scriptCell('leak', 'leak.sh', { env: { [SECRET_NAME]: `{{secret:${SECRET_NAME}}}` } })]);

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: 'secret_not_connected_on_this_device' });
    expect(runCount(f)).toBe(0);
  });

  it('never lets the output of a step reach the arguments of another, even for a flow stored outside the save path', async () => {
    const f = await boot();
    writeScript('print.sh', 'printf "payload"');
    writeScript('echo-args.sh', `touch ${marker('second-ran')}`);
    const playbook = await createPlaybook(f, []);
    new PlaybookRepository(f.db).insert({
      id: 'stored-outside', projectId: OWN_PROJECT_ID, name: 'Outside', inputs: [], policy: { browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 },
      agentLocked: false, origin: 'native', createdAt: 'now',
      flow: { cells: [
        { id: 'first', kind: 'script', program: 'print.sh', args: [], env: {} },
        { id: 'second', kind: 'script', program: 'echo-args.sh', args: ['{{steps.first.output}}'], env: {} },
      ] },
    });
    expect(playbook.id).not.toBe('stored-outside');
    expect((await approve(f, 'stored-outside')).status).toBe(200);

    const run = await runToTheEnd(f, 'stored-outside');

    expect(run).toMatchObject({ status: 'failed', errorCode: 'untrusted_reference' });
    expect(existsSync(marker('second-ran'))).toBe(false);
  });
});

describe('the limits of a run', () => {
  it('stops a flow that loops without end at the cap of step executions', async () => {
    const f = await boot({ maxStepExecutions: 3 });
    writeScript('tick.sh', `printf x >> ${marker('ticks')}`);
    new PlaybookRepository(f.db).insert({
      id: 'loops', projectId: OWN_PROJECT_ID, name: 'Loops', inputs: [], policy: { browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 }, agentLocked: false, origin: 'native', createdAt: 'now',
      flow: { cells: [{ id: 'again', kind: 'script', program: 'tick.sh', args: [], env: {}, next: [{ to: 'again' }] }] },
    });
    await approve(f, 'loops');

    const run = await runToTheEnd(f, 'loops');

    expect(run).toMatchObject({ status: 'failed', errorCode: 'step_limit_exceeded' });
    expect(run.steps).toHaveLength(3);
    expect(readFileSync(marker('ticks'), 'utf8')).toBe('xxx');
  });

  it('refuses a second run of a playbook that is running, then accepts it once the first ended', async () => {
    const f = await boot();
    writeScript('slow.sh', `touch ${marker('started')}\nwhile [ ! -f ${marker('go')} ]; do sleep 0.05; done`);
    const playbook = await createApprovedPlaybook(f, [scriptCell('slow', 'slow.sh')]);
    const first = await jsonOf<RunView>(await startRun(f, playbook.id));
    await waitUntil('the script to start', () => existsSync(marker('started')));

    const second = await startRun(f, playbook.id);
    writeFileSync(marker('go'), '');
    await waitUntil('the first run to end', async () => (await viewOfRun(f, first.id)).status !== 'running');
    const third = await startRun(f, playbook.id);

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect(third.status).toBe(202);
  });

  it('refuses a run beyond the cap of runs at the same time', async () => {
    const f = await boot({ maxConcurrentRuns: 2 });
    writeScript('slow.sh', `while [ ! -f ${marker('go')} ]; do sleep 0.05; done`);
    const playbooks = await Promise.all([1, 2, 3].map(() => createApprovedPlaybook(f, [scriptCell('slow', 'slow.sh')])));

    const answers = [await startRun(f, playbooks[0]!.id), await startRun(f, playbooks[1]!.id), await startRun(f, playbooks[2]!.id)];
    writeFileSync(marker('go'), '');

    expect(answers.map((answer) => answer.status)).toEqual([202, 202, 409]);
    expect(await answers[2]!.json()).toMatchObject({ error: 'playbook_run_busy' });
  });

  it('keeps at most maxRunsToKeep finished runs of a playbook, the newest', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createApprovedPlaybook(f, [scriptCell('say', 'hello.sh')], { policy: { maxRunsToKeep: 2 } });

    const first = await runToTheEnd(f, playbook.id);
    const second = await runToTheEnd(f, playbook.id);
    const third = await runToTheEnd(f, playbook.id);

    const kept = await jsonOf<RunView[]>(await f.api(`/api/playbook-runs?playbookId=${playbook.id}`));
    expect(kept.map((run) => run.id).sort()).toEqual([second.id, third.id].sort());
    expect(kept.map((run) => run.id)).not.toContain(first.id);
  });

  it('caps what a script prints at the output cap of a step', async () => {
    const f = await boot();
    writeScript('flood.sh', 'head -c 400000 /dev/zero | tr "\\0" "a"');
    const playbook = await createApprovedPlaybook(f, [scriptCell('flood', 'flood.sh')]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.output?.output?.length).toBeLessThanOrEqual(256 * 1024 + 64);
    expect(run.steps[0]?.output?.output?.endsWith('[truncated]')).toBe(true);
  });

  it('answers 404 playbook_run_not_found for a run that does not exist', async () => {
    const f = await boot();

    const answer = await f.api('/api/playbook-runs/nope');

    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: 'playbook_run_not_found' });
  });
});

describe('a daemon that stops during a step', () => {
  it('refuses to start a run once it is stopping, and writes no run', async () => {
    const f = await boot();
    writeScript('hello.sh', 'printf hello');
    const playbook = await createApprovedPlaybook(f, [scriptCell('say', 'hello.sh')]);
    await f.daemon.playbookRunner.stop();

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect(runCount(f)).toBe(0);
  });

  it('kills the script, journals the step as needs_review and never replays it', async () => {
    const f = await boot();
    writeScript('hang.sh', `printf '%s' "$$" > ${marker('pid')}\nprintf x >> ${marker('ran')}\nsleep 30`);
    const playbook = await createApprovedPlaybook(f, [scriptCell('hang', 'hang.sh')]);
    const { id } = await jsonOf<RunView>(await startRun(f, playbook.id));
    await waitUntil('the script to start', () => existsSync(marker('pid')) && existsSync(marker('ran')));

    await f.daemon.playbookRunner.stop();
    const run = await viewOfRun(f, id);

    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
    expect(run.steps.map((step) => step.status)).toEqual(['needs_review']);
    await waitUntil('the script to be gone', () => { try { process.kill(Number(readFileSync(marker('pid'), 'utf8')), 0); return false; } catch { return true; } });
    expect(readFileSync(marker('ran'), 'utf8')).toBe('x');
  }, 25_000);
});
