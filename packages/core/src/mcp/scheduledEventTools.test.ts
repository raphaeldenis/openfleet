import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

type ToolClient = Awaited<ReturnType<GovernanceFixture['connect']>>;
const textOf = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]!).text;
const callTool = async (client: ToolClient, name: string, args: Record<string, unknown> = {}) => textOf(await client.callTool({ name, arguments: args }));
const jsonOf = async (client: ToolClient, name: string, args: Record<string, unknown> = {}) => JSON.parse(await callTool(client, name, args));

describe('the scheduled event tools of a manager', () => {
  it('schedules an event, lists it, shows it in get_argus_status, and cancels it', async () => {
    const lead = await fixture.connect(fixture.lead.id);

    const scheduled = await jsonOf(lead, 'schedule_argus_event', { message: 'check the nightly run', title: 'Nightly', in_minutes: 30 });
    const listed = await jsonOf(lead, 'list_argus_events');
    const status = await jsonOf(lead, 'get_argus_status');
    const cancelled = await jsonOf(lead, 'cancel_argus_event', { event_id: scheduled.id });
    const listedAfterCancel = await jsonOf(lead, 'list_argus_events');

    expect(scheduled).toMatchObject({ title: 'Nightly', message: 'check the nightly run', creator: 'manager' });
    expect(listed.events.map((event: { id: string }) => event.id)).toEqual([scheduled.id]);
    expect(status.scheduled_events.map((event: { id: string }) => event.id)).toEqual([scheduled.id]);
    expect(cancelled).toEqual({ cancelled: scheduled.id });
    expect(listedAfterCancel.events).toEqual([]);
  });

  it('refuses `at` and `in_minutes` together in the error grammar', async () => {
    const lead = await fixture.connect(fixture.lead.id);

    const refusal = await callTool(lead, 'schedule_argus_event', { message: 'x', at: '2099-01-01T09:30:00', in_minutes: 5 });

    expect(refusal).toMatch(/^error invalid_body: /);
  });

  it('refuses a time in the past', async () => {
    const lead = await fixture.connect(fixture.lead.id);

    const refusal = await callTool(lead, 'schedule_argus_event', { message: 'x', at: '2001-01-01T09:30:00' });

    expect(refusal).toMatch(/^error invalid_body: .*past/);
  });

  it('keeps the events of one manager out of the list and the cancel of another', async () => {
    const lead = await fixture.connect(fixture.lead.id);
    const sibling = await fixture.connect(fixture.siblingLead.id);
    const scheduled = await jsonOf(lead, 'schedule_argus_event', { message: 'mine', in_minutes: 30 });

    const siblingList = await jsonOf(sibling, 'list_argus_events');
    const siblingCancel = await callTool(sibling, 'cancel_argus_event', { event_id: scheduled.id });

    expect(siblingList.events).toEqual([]);
    expect(siblingCancel).toMatch(/^error not_found: /);
    expect((await jsonOf(lead, 'list_argus_events')).events).toHaveLength(1);
  });

  it('refuses a session that is not a manager', async () => {
    const worker = await fixture.connect(fixture.worker.id);

    const refusal = await callTool(worker, 'schedule_argus_event', { message: 'x', in_minutes: 5 });

    expect(refusal).toMatch(/^error not_a_manager: /);
  });

  it('refuses the cancel of an event scheduled by the human', async () => {
    const lead = await fixture.connect(fixture.lead.id);
    const humanEvent = fixture.daemon.scheduledEvents.schedule({ managerId: fixture.lead.id, creator: 'human', message: 'from the human', inMinutes: 30 });

    const refusal = await callTool(lead, 'cancel_argus_event', { event_id: humanEvent.id });

    expect(refusal).toMatch(/^error outside_lineage: /);
    expect((await jsonOf(lead, 'list_argus_events')).events).toHaveLength(1);
  });
});
