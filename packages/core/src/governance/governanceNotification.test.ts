import { afterEach, beforeEach, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from './governanceQueue.testkit.js';

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

async function fileProposal() {
  const client = await fixture.connect(fixture.lead.id);
  const response = await client.callTool({ name: 'propose_law', arguments: { body: 'Keep changes small', incident: 'large change' } });
  const content = response.content as { text: string }[];
  const { request_id: proposalId } = JSON.parse(content[0]!.text) as { request_id: string };
  return { client, proposalId };
}

const decide = (proposalId: string, decision: string, reason?: string) => fixture.api(`/api/governance/proposals/${proposalId}/decide`, {
  method: 'POST', body: JSON.stringify({ decision, reason }),
});
const messages = () => fixture.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(fixture.lead.id) as { body: string }[];

async function startManagerPrompt() {
  const { hookToken } = await (await fixture.api(`/api/sessions/${fixture.lead.id}/tokens`)).json() as { hookToken: string };
  const response = await fixture.api(`/hooks/${hookToken}`, { method: 'POST', body: JSON.stringify({ session_id: fixture.lead.id, hook_event_name: 'SessionStart' }) });
  expect(response.status).toBe(200);
}

it('delivers to the prompt once the human clears their draft', async () => {
  const { proposalId } = await fileProposal();
  await startManagerPrompt();
  const input = (data: string) => fixture.api(`/api/sessions/${fixture.lead.id}/input`, { method: 'POST', body: JSON.stringify({ data }) });
  expect((await input('my unfinished draft')).status).toBe(200);
  expect((await decide(proposalId, 'approve')).status).toBe(200);

  const held = await (await fixture.api(`/api/sessions/${fixture.lead.id}/held-messages`)).json();
  expect(held).toEqual([expect.objectContaining({ heldFor: 'human_draft', body: expect.stringContaining(`Proposal ${proposalId} approved`) })]);
  expect(fixture.db.prepare('SELECT status FROM message_queue WHERE session_id = ?').get(fixture.lead.id)).toEqual({ status: 'queued' });

  expect((await input('\x03')).status).toBe(200);
  await expect.poll(() => fixture.db.prepare('SELECT status FROM message_queue WHERE session_id = ?').get(fixture.lead.id), { timeout: 8000 }).toEqual({ status: 'delivered' });
  expect(messages()).toHaveLength(1);
}, 10_000);

it.each([{ decision: 'approve', status: 'approved' }, { decision: 'deny', status: 'denied' }])('notifies once when a human decides $decision, including repeated decisions', async ({ decision, status }) => {
  const { proposalId } = await fileProposal();
  expect((await decide(proposalId, decision, 'covered by policy')).status).toBe(200);
  expect((await decide(proposalId, decision, 'covered by policy')).status).toBe(409);
  const notifications = messages();
  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.body).toContain(`Proposal ${proposalId} ${status}: covered by policy`);
  expect(notifications[0]!.body).toContain('governance');
  expect(notifications[0]!.body).toContain('untrusted');
});

it('does not notify when the manager withdraws', async () => {
  const { client, proposalId } = await fileProposal();
  await client.callTool({ name: 'withdraw_proposal', arguments: { request_id: proposalId } });
  expect(messages()).toEqual([]);
});

it('decides without waking a closed manager', async () => {
  const { proposalId } = await fileProposal();
  expect((await fixture.api(`/api/sessions/${fixture.lead.id}/close`, { method: 'POST', body: '{}' })).status).toBe(200);
  expect((await decide(proposalId, 'approve')).status).toBe(200);
  expect(messages()).toEqual([]);
  const session = await (await fixture.api(`/api/sessions/${fixture.lead.id}`)).json() as { state: string };
  expect(session.state).toBe('closed');
});

it('masks secrets and bounds the notification', async () => {
  const { proposalId } = await fileProposal();
  const secret = 'sk-ant-api03-' + 'a'.repeat(80);
  expect((await decide(proposalId, 'deny', `Never expose ${secret}`)).status).toBe(200);
  const body = messages()[0]!.body;
  expect(body).not.toContain(secret);
  expect(body.length).toBeLessThan(1500);
});
