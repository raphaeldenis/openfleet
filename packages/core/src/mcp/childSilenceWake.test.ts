import { afterEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

const TEN_MINUTES_MS = 10 * 60_000;

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
const fireLivingTimers = () => { for (const timer of livingTimers()) timer.callback(); };

async function bootFleetWhereWorkerIsChildOfLead() {
  armedTimers = [];
  nowMs = Date.parse('2026-10-30T10:00:00Z');
  fixture = await startGovernanceFixture({ childSilence: { schedule, clock: () => nowMs } });
  fixture.db.prepare('UPDATE sessions SET parent_id = ? WHERE id = ?').run(fixture.lead.id, fixture.worker.id);
  return { lead: await fixture.connect(fixture.lead.id), worker: await fixture.connect(fixture.worker.id) };
}
afterEach(async () => { await fixture.close(); });

type ToolClient = Awaited<ReturnType<GovernanceFixture['connect']>>;
const textOf = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]!).text;
const callTool = async (client: ToolClient, name: string, args: Record<string, unknown> = {}) => textOf(await client.callTool({ name, arguments: args }));
const messageChild = (lead: ToolClient) => callTool(lead, 'send_session_message', { target_uuid: fixture.worker.id, body: 'status?' });
const silenceLinesToLead = () =>
  (fixture.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(fixture.lead.id) as { body: string }[])
    .map((row) => row.body).filter((body) => body.startsWith('[scheduled event "silence_check"'));

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

  it('keeps one deadline per child: a second message replaces the first', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();

    await messageChild(lead);
    letTimePass(4 * 60_000);
    await messageChild(lead);
    fireLivingTimers();

    expect(armedTimers).toHaveLength(2);
    expect(armedTimers[0]!.isCancelled).toBe(true);
    expect(silenceLinesToLead()).toHaveLength(1);
  });

  it('wakes nobody when the child answered with message_parent', async () => {
    const { lead, worker } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await callTool(worker, 'message_parent', { body: 'on it' });
    fireLivingTimers();

    expect(livingTimers()).toEqual([]);
    expect(silenceLinesToLead()).toEqual([]);
  });

  it('wakes nobody when the child is closed before the deadline', async () => {
    const { lead } = await bootFleetWhereWorkerIsChildOfLead();
    await messageChild(lead);

    await fixture.api(`/api/sessions/${fixture.worker.id}/close`, { method: 'POST', body: JSON.stringify({}) });
    fireLivingTimers();

    expect(livingTimers()).toEqual([]);
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
});
