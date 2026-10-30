import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { makeRepo } from '../git/testRepo.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';

const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * MINUTE_MS;
const SILENCE_LINE_PREFIX = '[scheduled event "silence_check"';

interface ArmedTimer { callback: () => void; delayMs: number; isCancelled: boolean }

let fixture: GovernanceFixture;
let armedTimers: ArmedTimer[];
let nowMs: number;

const schedule = (callback: () => void, delayMs: number) => {
  const timer: ArmedTimer = { callback, delayMs, isCancelled: false };
  armedTimers.push(timer);
  return () => { timer.isCancelled = true; };
};
const livingTimers = () => armedTimers.filter((timer) => !timer.isCancelled);
const letTimePass = (milliseconds: number) => { nowMs += milliseconds; };
const makeChildStateOld = () => fixture.db.prepare('UPDATE sessions SET state_since = ? WHERE id = ?').run(new Date(nowMs - 30 * MINUTE_MS).toISOString(), fixture.worker.id);
const fireLivingTimers = () => {
  makeChildStateOld();
  for (const timer of livingTimers()) timer.callback();
};

async function bootFleetWhereWorkerIsChildOfLead() {
  armedTimers = [];
  nowMs = Date.now();
  fixture = await startGovernanceFixture({ childSilence: { schedule, clock: () => nowMs } });
  fixture.db.prepare('UPDATE sessions SET parent_id = ? WHERE id = ?').run(fixture.lead.id, fixture.worker.id);
  return { lead: await fixture.connect(fixture.lead.id), worker: await fixture.connect(fixture.worker.id) };
}
afterEach(async () => { await fixture.close(); });

type ToolClient = Awaited<ReturnType<GovernanceFixture['connect']>>;
const textOf = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]!).text;
const callTool = async (client: ToolClient, name: string, args: Record<string, unknown> = {}) => textOf(await client.callTool({ name, arguments: args }));
const messageChild = (lead: ToolClient, extra: Record<string, unknown> = {}) => callTool(lead, 'send_session_message', { target_uuid: fixture.worker.id, body: 'status?', ...extra });
const silenceLinesOf = (sessionId: string) =>
  (fixture.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(sessionId) as { body: string }[])
    .map((row) => row.body).filter((body) => body.startsWith(SILENCE_LINE_PREFIX));
const silenceLinesToLead = () => silenceLinesOf(fixture.lead.id);

describe('the silence check the runtime arms when a manager messages a child', () => {
  it('wakes the manager after ten minutes with the child and the age of its last sign of life', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();

    await messageChild(lead);
    letTimePass(TEN_MINUTES_MS);
    fireLivingTimers();

    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([TEN_MINUTES_MS]);
    const [line] = silenceLinesToLead();
    expect(line).toContain(fixture.worker.id);
    expect(line).toContain('Worker');
    expect(line).toMatch(/10 min/);
  });

  it('tells the manager the reminder is neither listed nor cancelled by the scheduled event tools', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();

    await messageChild(lead);
    letTimePass(TEN_MINUTES_MS);
    fireLivingTimers();

    const [line] = silenceLinesToLead();
    expect(line).toContain('not listed by list_argus_events');
    expect(line).toContain('cancel_argus_event');
  });

  it('keeps one deadline per child: a second message replaces the first', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();

    await messageChild(lead);
    letTimePass(4 * MINUTE_MS);
    await messageChild(lead);
    fireLivingTimers();

    expect(armedTimers).toHaveLength(2);
    expect(armedTimers[0]!.isCancelled).toBe(true);
    expect(silenceLinesToLead()).toHaveLength(1);
  });

  it('wakes nobody when a replaced deadline still fires', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);
    await messageChild(lead);
    letTimePass(TEN_MINUTES_MS);
    makeChildStateOld();

    armedTimers[0]!.callback();

    expect(silenceLinesToLead()).toEqual([]);
  });

  it('keeps the deadline when the same message_id is replayed', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    const messageId = '6f1c7a52-9d44-4c3e-8d2a-1b0f3a9e7c10';
    await messageChild(lead, { message_id: messageId });
    letTimePass(4 * MINUTE_MS);

    await messageChild(lead, { message_id: messageId });

    expect(armedTimers).toHaveLength(1);
    expect(armedTimers[0]!.isCancelled).toBe(false);
  });

  it('wakes nobody when the child answered with message_parent', async () => {
    const { lead, worker } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await callTool(worker, 'message_parent', { body: 'on it' });
    fireLivingTimers();

    expect(livingTimers()).toEqual([]);
    expect(silenceLinesToLead()).toEqual([]);
  });

  it('wakes nobody when the child answered with message_argus', async () => {
    const { lead, worker } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await callTool(worker, 'message_argus', { message: 'on it' });

    expect(livingTimers()).toEqual([]);
  });

  it('wakes nobody when the child answered with send_session_message to its manager', async () => {
    const { lead, worker } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await callTool(worker, 'send_session_message', { target_uuid: fixture.lead.id, body: 'on it' });

    expect(livingTimers()).toEqual([]);
  });

  it('wakes nobody when the child is closed before the deadline', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await fixture.api(`/api/sessions/${fixture.worker.id}/close`, { method: 'POST', body: JSON.stringify({}) });
    fireLivingTimers();

    expect(livingTimers()).toEqual([]);
    expect(silenceLinesToLead()).toEqual([]);
  });

  it('wakes nobody when the manager is closed before the deadline', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await fixture.api(`/api/sessions/${fixture.lead.id}/close`, { method: 'POST', body: JSON.stringify({}) });

    expect(livingTimers()).toEqual([]);
  });

  it('wakes nobody when the child is already closed at the deadline', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);
    fixture.db.prepare("UPDATE sessions SET state = 'closed' WHERE id = ?").run(fixture.worker.id);
    letTimePass(TEN_MINUTES_MS);

    fireLivingTimers();

    expect(silenceLinesToLead()).toEqual([]);
  });

  it('wakes nobody when the child changed state less than the delay ago', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);
    letTimePass(TEN_MINUTES_MS);
    fixture.db.prepare('UPDATE sessions SET state_since = ? WHERE id = ?').run(new Date(nowMs - MINUTE_MS).toISOString(), fixture.worker.id);

    for (const timer of livingTimers()) timer.callback();

    expect(silenceLinesToLead()).toEqual([]);
  });

  it('does not deliver the reminder to a disabled manager', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);
    await fixture.api(`/api/managers/${fixture.lead.id}`, { method: 'PATCH', body: JSON.stringify({ mode: 'disabled' }) });
    letTimePass(TEN_MINUTES_MS);

    fireLivingTimers();

    expect(silenceLinesToLead()).toEqual([]);
  });

  it('leaves the scheduled events of the manager untouched: not listed, not counted', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();

    await messageChild(lead);

    const listed = JSON.parse(await callTool(lead, 'list_argus_events'));
    const status = JSON.parse(await callTool(lead, 'get_argus_status'));
    expect(listed.events).toEqual([]);
    expect(status.scheduled_events).toEqual([]);
    expect(fixture.daemon.scheduledEvents.pendingOf(fixture.lead.id)).toEqual([]);
  });

  it('arms nothing when the child is the one writing to its manager', async () => {
    const { worker } = await bootFleetWhereWorkerIsChildOfLead();

    await callTool(worker, 'message_parent', { body: 'done' });

    expect(armedTimers).toEqual([]);
  });

  it('arms nothing when a manager that is not the parent tries to message the child', async () => {
    await bootFleetWhereWorkerIsChildOfLead();
    const sibling = await fixture.connect(fixture.siblingLead.id);

    const refusal = await callTool(sibling, 'send_session_message', { target_uuid: fixture.worker.id, body: 'status?' });

    expect(refusal).toMatch(/^error outside_lineage: /);
    expect(armedTimers).toEqual([]);
  });
});

describe('a reviewer that reports a no-go verdict to its manager', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();

  it('cancels the silence check of the manager', async () => {
    const { lead, worker } = await bootFleetWhereWorkerIsChildOfLead();
    const repo = makeRepo();
    const worktree = join(`${repo}-worktrees`, 'CCM-123-silence');
    git(repo, 'worktree', 'add', '-b', 'CCM-123-silence', worktree);
    fixture.db.prepare("UPDATE sessions SET role = 'reviewer', directory = ? WHERE id = ?").run(worktree, fixture.worker.id);
    await messageChild(lead);
    const sha = git(worktree, 'rev-parse', 'HEAD');

    await callTool(worker, 'report_ship_verdict', { verdict: 'no-go', sha, reasons: [{ claim: 'the migration cannot be rolled back', status: 'not_reproduced' }] });

    expect(livingTimers()).toEqual([]);
  });
});
