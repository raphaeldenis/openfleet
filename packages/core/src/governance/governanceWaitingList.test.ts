import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MAX_PENDING_PROPOSALS_PER_MANAGER, MAX_QUEUED_PROPOSALS_PER_MANAGER } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { startGovernanceFixture, OWN_PROJECT_ID, type GovernanceFixture } from './governanceQueue.testkit.js';

type Json = Record<string, any>;

let fixture: GovernanceFixture;
let lead: Client;
let siblingLead: Client;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  fixture = await startGovernanceFixture();
  [lead, siblingLead] = await Promise.all([fixture.connect(fixture.lead.id), fixture.connect(fixture.siblingLead.id)]);
});
afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await fixture.close();
});

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const jsonOf = async (client: Client, name: string, args: Record<string, unknown> = {}) => JSON.parse(textOf(await call(client, name, args))) as Json;
const governanceOf = (client: Client) => jsonOf(client, 'get_argus_governance');
const proposeLaw = (client: Client, body: string) => jsonOf(client, 'propose_law', { body, incident: 'it happened again' });
const proposeLaws = async (client: Client, count: number, label = 'Law') => {
  const acks: Json[] = [];
  for (let index = 0; index < count; index += 1) acks.push(await proposeLaw(client, `${label} ${index}`));
  return acks;
};
const decide = (proposalId: string, decision: 'approve' | 'deny' = 'approve') =>
  fixture.api(`/api/governance/proposals/${proposalId}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason: decision === 'deny' ? 'no' : undefined }) });
const withdraw = (client: Client, requestId: string) => jsonOf(client, 'withdraw_proposal', { request_id: requestId });
const countRows = (table: string) => (fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const waitingIdsOf = (managerId: string) => (fixture.db.prepare('SELECT id FROM governance_waiting_proposals WHERE manager_id = ? ORDER BY created_at, rowid').all(managerId) as { id: string }[]).map((row) => row.id);
const pendingIdsOf = (client: Client) => governanceOf(client).then((view) => (view.pending as Json[]).map((entry) => entry.request_id as string));
const queuedIdsOf = (client: Client) => governanceOf(client).then((view) => (view.queued as Json[]).map((entry) => entry.request_id as string));
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function openClient(): Promise<{ frames: Json[] }> {
  const { ticket } = (await (await fixture.api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const socket = new WebSocket(`${fixture.daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Json[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitForFrame(frames, (frame) => frame.type === 'snapshot');
  return { frames };
}

async function waitForFrame(frames: Json[], matches: (frame: Json) => boolean): Promise<Json> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 500)}`);
}

describe('a manager that files more proposals than the pending places', () => {
  it('has 10 pending and the surplus waiting, acknowledged with its queue position', async () => {
    const acks = await proposeLaws(lead, 12);

    expect(acks.slice(0, 10).map((ack) => ack.status)).toEqual(Array(10).fill('pending'));
    expect(acks[10]).toMatchObject({ status: 'queued', position: 1, queuedCount: 1, note: expect.stringMatching(/queued, position 1.*released in order.*do not re-propose/i) });
    expect(acks[11]).toMatchObject({ status: 'queued', position: 2, queuedCount: 2, note: expect.stringMatching(/position 2/) });
    expect(acks[11]!.request_id).toEqual(expect.any(String));
  });

  it('reads back the waiting proposals in `queued`, in filing order, with the pending ones unchanged', async () => {
    const acks = await proposeLaws(lead, 12);

    const view = await governanceOf(lead);

    expect(view.pending.map((entry: Json) => entry.request_id)).toEqual(acks.slice(0, 10).map((ack) => ack.request_id));
    expect(view.queued).toEqual([
      expect.objectContaining({ request_id: acks[10]!.request_id, kind: 'law', text: 'Law 10', incident: 'it happened again', position: 1, createdAt: expect.any(String) }),
      expect.objectContaining({ request_id: acks[11]!.request_id, text: 'Law 11', position: 2 }),
    ]);
    expect(view.queuedCount).toBe(2);
    expect(view.note).toContain('`queued`');
  });

  it('has all twelve answered in filing order, with nothing proposed again and no governance_queue_full', async () => {
    const acks = await proposeLaws(lead, 12);
    const answeredOrder: string[] = [];

    for (let turn = 0; turn < 12; turn += 1) {
      const [oldestPending] = await pendingIdsOf(lead);
      answeredOrder.push(oldestPending!);
      expect((await decide(oldestPending!)).status).toBe(200);
    }

    expect(answeredOrder).toEqual(acks.map((ack) => ack.request_id));
    expect(countRows('governance_waiting_proposals')).toBe(0);
    expect(await pendingIdsOf(lead)).toEqual([]);
    expect(countRows('governance_proposals')).toBe(12);
  });

  it('releases one waiting proposal per place freed by a decision, the oldest first, keeping its original filing date', async () => {
    const acks = await proposeLaws(lead, 13);
    const waitingBefore = fixture.db.prepare('SELECT id, created_at FROM governance_waiting_proposals ORDER BY created_at, rowid').all() as { id: string; created_at: string }[];

    await decide(acks[0]!.request_id, 'deny');
    const afterFirst = await governanceOf(lead);
    await decide(acks[1]!.request_id);
    const afterSecond = await governanceOf(lead);

    expect(afterFirst.pending).toHaveLength(10);
    expect(afterFirst.pending.at(-1)).toMatchObject({ request_id: acks[10]!.request_id });
    expect(afterFirst.queued.map((entry: Json) => entry.request_id)).toEqual([acks[11]!.request_id, acks[12]!.request_id]);
    expect(afterSecond.pending.at(-1)).toMatchObject({ request_id: acks[11]!.request_id });
    expect(afterSecond.queuedCount).toBe(1);
    const releasedRow = fixture.db.prepare('SELECT created_at FROM governance_proposals WHERE id = ?').get(acks[10]!.request_id) as { created_at: string };
    expect(releasedRow.created_at).toBe(waitingBefore[0]!.created_at);
  });

  it('releases one waiting proposal when the manager withdraws a pending one', async () => {
    const acks = await proposeLaws(lead, 12);

    const result = await withdraw(lead, acks[3]!.request_id);

    expect(result).toEqual({ request_id: acks[3]!.request_id, status: 'withdrawn' });
    expect(await pendingIdsOf(lead)).toEqual([...acks.slice(0, 3), ...acks.slice(4, 11)].map((ack) => ack.request_id));
    expect(await queuedIdsOf(lead)).toEqual([acks[11]!.request_id]);
  });

  it('erases a waiting proposal that is withdrawn, releases nothing and leaves no history', async () => {
    const acks = await proposeLaws(lead, 12);

    const result = await withdraw(lead, acks[10]!.request_id);
    const view = await governanceOf(lead);

    expect(result).toEqual({ request_id: acks[10]!.request_id, status: 'withdrawn' });
    expect(view.pending).toHaveLength(10);
    expect(view.queued.map((entry: Json) => entry.request_id)).toEqual([acks[11]!.request_id]);
    expect(view.queued[0]).toMatchObject({ position: 1 });
    expect(view.history).toEqual([]);
    expect(countRows('governance_proposals')).toBe(10);
  });

  it('refuses to decide a waiting proposal: it does not exist for the human until it is released', async () => {
    const acks = await proposeLaws(lead, 11);

    const response = await decide(acks[10]!.request_id);

    expect(response.status).toBe(404);
    expect(((await response.json()) as Json).error).toBe('proposal_not_found');
    expect(await queuedIdsOf(lead)).toEqual([acks[10]!.request_id]);
  });

  it('does not list waiting proposals as pending for the human', async () => {
    await proposeLaws(lead, 11);

    const listed = await (await fixture.api('/api/governance/proposals')).json() as Json[];

    expect(listed).toHaveLength(10);
  });

  it('sees an approved law released from the waiting list enacted in `laws`, with its proposal id', async () => {
    const acks = await proposeLaws(lead, 11);
    await decide(acks[0]!.request_id);

    const response = await decide(acks[10]!.request_id);

    expect(response.status).toBe(200);
    const enacted = fixture.db.prepare('SELECT text, source_kind, proposal_id, manager_id FROM laws WHERE proposal_id = ?').get(acks[10]!.request_id);
    expect(enacted).toEqual({ text: 'Law 10', source_kind: 'proposal', proposal_id: acks[10]!.request_id, manager_id: fixture.lead.id });
  });

  it('files permissions and resource accesses in the same single order as laws', async () => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');
    await proposeLaws(lead, 10);

    const permission = await jsonOf(lead, 'propose_permission', { action: 'reap', scope: 'idle worktrees', condition: 'load below 30', exclusions: 'dirty', incident: 'disk full' });
    const access = await jsonOf(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident: 'need it' });

    expect(permission).toMatchObject({ status: 'queued', position: 1 });
    expect(access).toMatchObject({ status: 'queued', position: 2 });
    expect((await governanceOf(lead)).queued.map((entry: Json) => entry.kind)).toEqual(['permission', 'resourceAccess']);
  });

  it('parks a new proposal behind the waiting ones even when a place is free, so the order never inverts', async () => {
    await proposeLaws(lead, 11);
    fixture.db.prepare("DELETE FROM governance_proposals WHERE id = (SELECT id FROM governance_proposals ORDER BY rowid LIMIT 1)").run();

    const ack = await proposeLaw(lead, 'Latecomer');

    expect(ack).toMatchObject({ status: 'queued', position: 2 });
  });
});

describe('the same proposal filed again', () => {
  it('answers the id of its pending twin, adds no row and no event', async () => {
    const [first] = await proposeLaws(lead, 12);
    const { frames } = await openClient();
    const rowsBefore = countRows('governance_proposals') + countRows('governance_waiting_proposals');

    const again = await proposeLaw(lead, 'Law 0');
    await settle();

    expect(again).toMatchObject({ request_id: first!.request_id, status: 'pending', deduplicated: true });
    expect(countRows('governance_proposals') + countRows('governance_waiting_proposals')).toBe(rowsBefore);
    expect(frames.filter((frame) => frame.type.startsWith('governance.'))).toEqual([]);
  });

  it('answers the id of its waiting twin with its position, adds no row and no event', async () => {
    const acks = await proposeLaws(lead, 12);
    const { frames } = await openClient();
    const rowsBefore = countRows('governance_proposals') + countRows('governance_waiting_proposals');

    const again = await proposeLaw(lead, 'Law 11');
    await settle();

    expect(again).toMatchObject({ request_id: acks[11]!.request_id, status: 'queued', position: 2, queuedCount: 2, deduplicated: true });
    expect(countRows('governance_proposals') + countRows('governance_waiting_proposals')).toBe(rowsBefore);
    expect(frames.filter((frame) => frame.type.startsWith('governance.'))).toEqual([]);
  });

  it('is deduplicated even when the waiting list is full', async () => {
    const acks = await proposeLaws(lead, MAX_PENDING_PROPOSALS_PER_MANAGER + MAX_QUEUED_PROPOSALS_PER_MANAGER);

    const again = await proposeLaw(lead, `Law ${MAX_PENDING_PROPOSALS_PER_MANAGER + MAX_QUEUED_PROPOSALS_PER_MANAGER - 1}`);

    expect(again).toMatchObject({ request_id: acks.at(-1)!.request_id, deduplicated: true });
  });
});

describe('the waiting list cap', () => {
  it('accepts 10 pending and 50 waiting, then refuses the next one with governance_queue_full', async () => {
    await proposeLaws(lead, MAX_PENDING_PROPOSALS_PER_MANAGER + MAX_QUEUED_PROPOSALS_PER_MANAGER);

    const refused = textOf(await call(lead, 'propose_law', { body: 'One too many', incident: 'x' }));

    expect((await governanceOf(lead)).queuedCount).toBe(MAX_QUEUED_PROPOSALS_PER_MANAGER);
    expect(refused).toMatch(/^error governance_queue_full: .*10 pending.*50 waiting.* \(retry: later\)$/s);
    expect(refused).toContain('withdraw_proposal');
  });

  it('takes a proposal again as soon as a decision frees a place', async () => {
    const acks = await proposeLaws(lead, MAX_PENDING_PROPOSALS_PER_MANAGER + MAX_QUEUED_PROPOSALS_PER_MANAGER);
    await decide(acks[0]!.request_id);

    const ack = await proposeLaw(lead, 'Fits again');

    expect(ack).toMatchObject({ status: 'queued', position: MAX_QUEUED_PROPOSALS_PER_MANAGER });
  });
});

describe('the isolation between managers', () => {
  it('keeps the waiting list of each manager on its own', async () => {
    await proposeLaws(lead, 12);

    const siblingAck = await proposeLaw(siblingLead, 'Sibling law');
    const siblingView = await governanceOf(siblingLead);

    expect(siblingAck).toMatchObject({ status: 'pending' });
    expect(siblingView).toMatchObject({ queued: [], queuedCount: 0 });
  });

  it('answers proposal_not_found when a manager withdraws the waiting proposal of another, and keeps it waiting', async () => {
    const acks = await proposeLaws(lead, 11);

    const result = textOf(await call(siblingLead, 'withdraw_proposal', { request_id: acks[10]!.request_id }));

    expect(result).toMatch(/^error proposal_not_found: /);
    expect(await queuedIdsOf(lead)).toEqual([acks[10]!.request_id]);
  });

  it('does not release the waiting proposals of a manager when the other one is answered', async () => {
    await proposeLaws(lead, 11);
    const [siblingFirst] = await proposeLaws(siblingLead, 1, 'Sibling');

    await decide(siblingFirst!.request_id);

    expect((await governanceOf(lead)).queuedCount).toBe(1);
  });
});

describe('concurrent answers', () => {
  it('never releases more proposals than there are free places', async () => {
    const acks = await proposeLaws(lead, 15);

    await Promise.all([
      decide(acks[0]!.request_id),
      decide(acks[0]!.request_id),
      withdraw(lead, acks[1]!.request_id),
      withdraw(lead, acks[1]!.request_id).catch(() => undefined),
      decide(acks[2]!.request_id, 'deny'),
    ]);
    const view = await governanceOf(lead);

    expect(view.pending).toHaveLength(10);
    expect(view.queuedCount).toBe(2);
    expect(countRows('governance_proposals')).toBe(15 - 2);
  });
});

describe('the manager that is closed or deleted', () => {
  it('keeps its waiting proposals while closed and releases one at each decision', async () => {
    const acks = await proposeLaws(lead, 12);
    expect((await fixture.api(`/api/sessions/${fixture.lead.id}/close`, { method: 'POST', body: '{}' })).status).toBe(200);

    await decide(acks[0]!.request_id);

    expect(waitingIdsOf(fixture.lead.id)).toEqual([acks[11]!.request_id]);
    expect(fixture.governanceQueue.viewOf(fixture.lead.id).pending.map((proposal) => proposal.id)).toContain(acks[10]!.request_id);
  });

  it('removes its waiting proposals with it', async () => {
    await proposeLaws(lead, 12);
    await proposeLaws(siblingLead, 11);

    fixture.db.prepare('DELETE FROM managers WHERE session_id = ?').run(fixture.lead.id);

    expect(waitingIdsOf(fixture.lead.id)).toEqual([]);
    expect(waitingIdsOf(fixture.siblingLead.id)).toHaveLength(1);
  });
});

describe('the message to the manager after a decision', () => {
  const messages = () => (fixture.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(fixture.lead.id) as { body: string }[]).map((row) => row.body);

  it('tells which queued proposal is now pending', async () => {
    const acks = await proposeLaws(lead, 11);

    await decide(acks[0]!.request_id);

    const [notification] = messages();
    expect(notification).toContain(`Proposal ${acks[0]!.request_id} approved`);
    expect(notification).toContain(`Queued proposal ${acks[10]!.request_id} is now pending`);
  });

  it('keeps the mention when a long denial reason fills the body', async () => {
    const acks = await proposeLaws(lead, 11);

    await fixture.api(`/api/governance/proposals/${acks[0]!.request_id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'deny', reason: 'r'.repeat(500) }) });

    expect(messages()[0]).toContain(`Queued proposal ${acks[10]!.request_id} is now pending`);
  });

  it('says nothing about the queue when nothing was released', async () => {
    const acks = await proposeLaws(lead, 3);

    await decide(acks[0]!.request_id);

    expect(messages()[0]).not.toContain('Queued proposal');
  });

  it('stays silent when the manager withdraws, even when that releases a proposal', async () => {
    const acks = await proposeLaws(lead, 11);

    await withdraw(lead, acks[0]!.request_id);

    expect(messages()).toEqual([]);
    expect(await queuedIdsOf(lead)).toEqual([]);
  });
});

describe('the governance events over the WebSocket', () => {
  it('tells the queue size when a proposal is parked', async () => {
    await proposeLaws(lead, 10);
    const { frames } = await openClient();

    await proposeLaw(lead, 'Parked');
    const changed = await waitForFrame(frames, (frame) => frame.type === 'governance.queue_changed');
    await settle();

    expect(changed).toMatchObject({ type: 'governance.queue_changed', managerId: fixture.lead.id, queuedCount: 1 });
    expect(frames.filter((frame) => frame.type === 'governance.proposed')).toEqual([]);
  });

  it('announces governance.proposed for each release, then the new queue size', async () => {
    const acks = await proposeLaws(lead, 11);
    const { frames } = await openClient();

    await decide(acks[0]!.request_id);
    await waitForFrame(frames, (frame) => frame.type === 'governance.queue_changed');
    await settle();

    const governanceFrames = frames.filter((frame) => frame.type.startsWith('governance.'));
    expect(governanceFrames.map((frame) => frame.type)).toEqual(['governance.resolved', 'governance.proposed', 'governance.queue_changed']);
    expect(governanceFrames[1]!.proposal).toMatchObject({ id: acks[10]!.request_id, status: 'pending', managerId: fixture.lead.id });
    expect(governanceFrames[2]).toMatchObject({ managerId: fixture.lead.id, queuedCount: 0 });
  });

  it('tells the queue size when a waiting proposal is withdrawn', async () => {
    const acks = await proposeLaws(lead, 12);
    const { frames } = await openClient();

    await withdraw(lead, acks[10]!.request_id);
    const changed = await waitForFrame(frames, (frame) => frame.type === 'governance.queue_changed');
    await settle();

    expect(changed).toMatchObject({ managerId: fixture.lead.id, queuedCount: 1 });
    expect(frames.filter((frame) => frame.type.startsWith('governance.') && frame.type !== 'governance.queue_changed')).toEqual([]);
  });

  it('carries the waiting counts of the managers in the snapshot, omitting those with nothing waiting', async () => {
    await proposeLaws(lead, 12);
    await proposeLaws(siblingLead, 2);

    const { frames } = await openClient();

    expect(frames.find((frame) => frame.type === 'snapshot')!.queuedCounts).toEqual({ [fixture.lead.id]: 2 });
  });
});

describe('the waiting list across a daemon restart', () => {
  const directories = createTempDirTracker();
  afterEach(() => { directories.removeAll(); });

  it('keeps the waiting proposals in their order and releases them in it', async () => {
    const home = directories.make('governance-waiting-restart-');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
    const options = { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } };
    const firstRun = await startDaemon(config, options);
    const created = await fetch(`${firstRun.server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ directory: home, name: 'Lead', harness: 'fake', emoji: '🤖', manager: { childrenCap: 1, mission: 'x', pulseSeconds: 3600 } }) });
    const { id } = await created.json() as { id: string };
    const filed = Array.from({ length: 13 }, (_, index) => firstRun.governanceQueue.proposeLaw({ managerId: id, text: `Law ${index}`, incident: 'restart' }));
    await firstRun.close();

    const secondRun = await startDaemon(config, options);
    const waitingTexts = secondRun.governanceQueue.viewOf(id).queued.map((proposal) => (proposal.payload as { text: string }).text);
    secondRun.governanceQueue.decide({ proposalId: filed[0]!.proposal.id, decision: 'approve' });
    const pendingAfterDecision = secondRun.governanceQueue.viewOf(id).pending.map((proposal) => proposal.id);
    await secondRun.close();

    expect(waitingTexts).toEqual(['Law 10', 'Law 11', 'Law 12']);
    expect(pendingAfterDecision).toEqual(filed.slice(1, 11).map((entry) => entry.proposal.id));
  });
});
