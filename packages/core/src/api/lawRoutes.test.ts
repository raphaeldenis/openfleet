import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MAX_LAW_TEXT_CHARS } from '@openfleet/shared';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

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

interface LawOfAdmin { id: string; managerId: string; text: string; status: string; revision: number; updatedAt: string; updatedBy?: string; withdrawnAt?: string; withdrawnBy?: string; proposalId?: string }

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text) as Record<string, any>;
const activeLawsOf = async (client: Client) => (await call(client, 'get_argus_governance')).laws as { id: string; text: string; revision: number }[];
const enactLaw = async (client: Client, body = 'Never force-push') => {
  const { request_id } = await call(client, 'propose_law', { body, incident: 'force push on main' });
  await fixture.api(`/api/governance/proposals/${request_id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  const managerId = client === lead ? fixture.lead.id : fixture.siblingLead.id;
  return (await storedLawsOf(managerId)).find((law) => law.text === body)!;
};
const storedLawsOf = async (managerId: string) => ((await (await fixture.api(`/api/managers/${managerId}/governance`)).json()) as { laws: LawOfAdmin[] }).laws;
const editLaw = (lawId: string, body: unknown, headers: Record<string, string> = {}) =>
  fixture.api(`/api/governance/laws/${lawId}`, { method: 'PATCH', body: JSON.stringify(body), headers });
const withdrawLaw = (lawId: string, body: unknown, headers: Record<string, string> = {}) =>
  fixture.api(`/api/governance/laws/${lawId}/withdraw`, { method: 'POST', body: JSON.stringify(body), headers });
const errorOf = async (response: Response) => (await response.json()) as { error: string; kind: string; detail?: { currentRev?: number } };
const sessionTokenOf = (sessionId: string) => (fixture.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const lawRowOf = (lawId: string) => fixture.db.prepare('SELECT * FROM laws WHERE id = ?').get(lawId);
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function openClient(): Promise<{ frames: Record<string, any>[] }> {
  const { ticket } = (await (await fixture.api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const socket = new WebSocket(`${fixture.daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Record<string, any>[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitForFrame(frames, (frame) => frame.type === 'snapshot');
  return { frames };
}

async function waitForFrame(frames: Record<string, any>[], matches: (frame: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 500)}`);
}

describe('PATCH /api/governance/laws/:id', () => {
  it('replaces the text, adds one to the revision and records the human as the editor', async () => {
    const law = await enactLaw(lead);

    const response = await editLaw(law.id, { text: 'Never force-push to main', expectedRevision: 1 });

    expect(response.status).toBe(200);
    const edited = (await response.json()) as LawOfAdmin;
    expect(edited).toMatchObject({ id: law.id, text: 'Never force-push to main', revision: 2, status: 'active', updatedBy: 'admin' });
    expect((await storedLawsOf(fixture.lead.id))[0]).toMatchObject({ text: 'Never force-push to main', revision: 2, updatedBy: 'admin' });
  });

  it('shows the manager the edited text and the new revision', async () => {
    const law = await enactLaw(lead);

    await editLaw(law.id, { text: 'Never force-push to main', expectedRevision: 1 });

    expect(await activeLawsOf(lead)).toMatchObject([{ id: law.id, text: 'Never force-push to main', revision: 2 }]);
  });

  it('answers 409 law_revision_conflict with the current revision, and changes nothing, when the revision is stale', async () => {
    const law = await enactLaw(lead);
    await editLaw(law.id, { text: 'First edit', expectedRevision: 1 });
    const before = lawRowOf(law.id);

    const response = await editLaw(law.id, { text: 'Second edit', expectedRevision: 1 });

    expect(response.status).toBe(409);
    const refusal = await errorOf(response);
    expect(refusal).toMatchObject({ error: 'law_revision_conflict', detail: { currentRev: 2 } });
    expect(lawRowOf(law.id)).toEqual(before);
    expect(await activeLawsOf(lead)).toMatchObject([{ text: 'First edit', revision: 2 }]);
  });

  it('lets exactly one of two concurrent edits on the same revision win', async () => {
    const law = await enactLaw(lead);

    const responses = await Promise.all([editLaw(law.id, { text: 'Edit A', expectedRevision: 1 }), editLaw(law.id, { text: 'Edit B', expectedRevision: 1 })]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect((await storedLawsOf(fixture.lead.id))[0]!.revision).toBe(2);
  });

  it('answers 404 law_not_found for an unknown law', async () => {
    const response = await editLaw('no-such-law', { text: 'x', expectedRevision: 1 });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe('law_not_found');
  });

  it.each([['an empty text', ''], ['a blank text', '   \n '], ['a text over the limit', 'x'.repeat(MAX_LAW_TEXT_CHARS + 1)]])('refuses %s with invalid_body and keeps the law', async (_label, text) => {
    const law = await enactLaw(lead);
    const before = lawRowOf(law.id);

    const response = await editLaw(law.id, { text, expectedRevision: 1 });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
    expect(lawRowOf(law.id)).toEqual(before);
  });

  it('accepts a text of exactly the limit', async () => {
    const law = await enactLaw(lead);

    const response = await editLaw(law.id, { text: 'x'.repeat(MAX_LAW_TEXT_CHARS), expectedRevision: 1 });

    expect(response.status).toBe(200);
  });

  it.each([['missing', undefined], ['zero', 0], ['a string', '1'], ['a fraction', 1.5]])('refuses an expectedRevision that is %s with invalid_body', async (_label, expectedRevision) => {
    const law = await enactLaw(lead);

    const response = await editLaw(law.id, { text: 'New text', expectedRevision });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
  });

  it('masks a secret written in the text before storing it', async () => {
    const law = await enactLaw(lead);

    await editLaw(law.id, { text: 'Never paste Bearer abcdef1234567890SECRETvalue anywhere', expectedRevision: 1 });

    expect(JSON.stringify(lawRowOf(law.id))).not.toContain('abcdef1234567890SECRETvalue');
    expect(JSON.stringify(await activeLawsOf(lead))).not.toContain('abcdef1234567890SECRETvalue');
  });

  it('keeps the proposal of origin untouched', async () => {
    const law = await enactLaw(lead, 'Original wording');
    const proposalOf = () => fixture.db.prepare('SELECT * FROM governance_proposals WHERE id = ?').get(law.proposalId as string);
    const before = proposalOf();

    await editLaw(law.id, { text: 'Reworded', expectedRevision: 1 });

    expect(proposalOf()).toEqual(before);
  });

  it('refuses to edit a withdrawn law with 409 law_withdrawn', async () => {
    const law = await enactLaw(lead);
    await withdrawLaw(law.id, { expectedRevision: 1 });

    const response = await editLaw(law.id, { text: 'Too late', expectedRevision: 2 });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).error).toBe('law_withdrawn');
    expect((await storedLawsOf(fixture.lead.id))[0]).toMatchObject({ text: 'Never force-push', status: 'withdrawn' });
  });
});

describe('POST /api/governance/laws/:id/withdraw', () => {
  it('withdraws the law, adds one to the revision and records who and when', async () => {
    const law = await enactLaw(lead);

    const response = await withdrawLaw(law.id, { expectedRevision: 1 });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: law.id, status: 'withdrawn', revision: 2, withdrawnBy: 'admin', withdrawnAt: expect.any(String) });
  });

  it('removes the law from the active laws of the manager', async () => {
    const law = await enactLaw(lead);
    await enactLaw(lead, 'Another rule');

    await withdrawLaw(law.id, { expectedRevision: 1 });

    expect((await activeLawsOf(lead)).map(({ text }) => text)).toEqual(['Another rule']);
  });

  it('answers 409 law_revision_conflict, and keeps the law active, when the revision is stale', async () => {
    const law = await enactLaw(lead);
    await editLaw(law.id, { text: 'Edited', expectedRevision: 1 });

    const response = await withdrawLaw(law.id, { expectedRevision: 1 });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({ error: 'law_revision_conflict', detail: { currentRev: 2 } });
    expect(await activeLawsOf(lead)).toHaveLength(1);
  });

  it('refuses a second withdrawal with 409 law_withdrawn and leaves the first one as it was', async () => {
    const law = await enactLaw(lead);
    await withdrawLaw(law.id, { expectedRevision: 1 });
    const before = lawRowOf(law.id);

    const response = await withdrawLaw(law.id, { expectedRevision: 2 });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).error).toBe('law_withdrawn');
    expect(lawRowOf(law.id)).toEqual(before);
  });

  it('answers 404 law_not_found for an unknown law', async () => {
    const response = await withdrawLaw('no-such-law', { expectedRevision: 1 });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe('law_not_found');
  });

  it('keeps the laws of another manager', async () => {
    const law = await enactLaw(lead);
    await enactLaw(siblingLead, 'Sibling rule');

    await withdrawLaw(law.id, { expectedRevision: 1 });

    expect((await activeLawsOf(siblingLead)).map(({ text }) => text)).toEqual(['Sibling rule']);
  });
});

describe('the admin token protects the law routes, and /mcp offers no way to change a law', () => {
  const routes = [
    { label: 'PATCH /api/governance/laws/:id', method: 'PATCH', path: '/api/governance/laws/any-id', body: { text: 'x', expectedRevision: 1 } },
    { label: 'POST /api/governance/laws/:id/withdraw', method: 'POST', path: '/api/governance/laws/any-id/withdraw', body: { expectedRevision: 1 } },
  ];

  for (const route of routes) {
    it.each([
      ['the session MCP token', () => `Bearer ${sessionTokenOf(fixture.lead.id)}`],
      ['no authorization header', () => undefined],
    ])(`refuses ${route.label} with %s: 401 unauthorized`, async (_label, authorization) => {
      const law = await enactLaw(lead);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const header = authorization();
      if (header !== undefined) headers.authorization = header;

      const response = await fetch(`${fixture.daemon.server.url}${route.path.replace('any-id', law.id)}`, { method: route.method, headers, body: JSON.stringify(route.body) });

      expect(response.status).toBe(401);
      expect((await errorOf(response)).error).toBe('unauthorized');
      expect((await storedLawsOf(fixture.lead.id))[0]).toMatchObject({ text: 'Never force-push', revision: 1, status: 'active' });
    });
  }

  it('lists no tool that edits or withdraws a law', async () => {
    const { tools } = await lead.listTools();

    const lawEditingTools = tools.map(({ name }) => name).filter((name) => /law/i.test(name) && name !== 'propose_law');

    expect(lawEditingTools).toEqual([]);
  });

  it('answers 404 when the session token calls a law path under /mcp', async () => {
    const law = await enactLaw(lead);

    const response = await fetch(`${fixture.daemon.server.url}/mcp/governance/laws/${law.id}`, {
      method: 'PATCH', body: JSON.stringify({ text: 'x', expectedRevision: 1 }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionTokenOf(fixture.lead.id)}` },
    });

    expect(response.status).toBe(404);
    expect((await storedLawsOf(fixture.lead.id))[0]!.revision).toBe(1);
  });
});

describe('law events over the WebSocket', () => {
  it('broadcasts law.created with the whole law when a human approves a law proposal', async () => {
    const { request_id } = await call(lead, 'propose_law', { body: 'Never force-push', incident: 'x' });
    const { frames } = await openClient();

    await fixture.api(`/api/governance/proposals/${request_id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });

    const created = await waitForFrame(frames, (frame) => frame.type === 'law.created');
    expect(created.law).toMatchObject({ managerId: fixture.lead.id, text: 'Never force-push', status: 'active', revision: 1, proposalId: request_id });
  });

  it('broadcasts law.updated with the whole edited law', async () => {
    const law = await enactLaw(lead);
    const { frames } = await openClient();

    await editLaw(law.id, { text: 'Reworded', expectedRevision: 1 });

    const updated = await waitForFrame(frames, (frame) => frame.type === 'law.updated');
    expect(updated.law).toMatchObject({ id: law.id, managerId: fixture.lead.id, text: 'Reworded', revision: 2, updatedBy: 'admin' });
  });

  it('broadcasts law.withdrawn with the whole withdrawn law', async () => {
    const law = await enactLaw(lead);
    const { frames } = await openClient();

    await withdrawLaw(law.id, { expectedRevision: 1 });

    const withdrawn = await waitForFrame(frames, (frame) => frame.type === 'law.withdrawn');
    expect(withdrawn.law).toMatchObject({ id: law.id, status: 'withdrawn', revision: 2 });
  });

  it('broadcasts nothing when an edit or a withdrawal is refused', async () => {
    const law = await enactLaw(lead);
    const { frames } = await openClient();

    await editLaw(law.id, { text: 'Stale', expectedRevision: 9 });
    await editLaw(law.id, { text: '', expectedRevision: 1 });
    await withdrawLaw('no-such-law', { expectedRevision: 1 });
    await settle();

    expect(frames.filter((frame) => frame.type.startsWith('law.'))).toEqual([]);
  });
});
