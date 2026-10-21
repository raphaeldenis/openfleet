import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { startGovernanceFixture, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

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

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text) as Record<string, any>;
const governanceOf = (client: Client) => call(client, 'get_argus_governance');
const proposeLaw = async (client: Client, body = 'Never force-push') => (await call(client, 'propose_law', { body, incident: 'force push on main' })).request_id as string;
const decide = (proposalId: string, body: unknown, headers: Record<string, string> = {}) =>
  fixture.api(`/api/governance/proposals/${proposalId}/decide`, { method: 'POST', body: JSON.stringify(body), headers });
const sessionTokenOf = (sessionId: string) => (fixture.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const errorOf = async (response: Response) => (await response.json()) as { error: string; kind: string };

async function openClient(): Promise<{ frames: Record<string, any>[] }> {
  const ticketResponse = await fixture.api('/api/ws-ticket', { method: 'POST' });
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('GET /api/governance/proposals', () => {
  it('lists the pending proposals of every manager, oldest first', async () => {
    const fromLead = await proposeLaw(lead, 'Lead law');
    const fromSibling = await proposeLaw(siblingLead, 'Sibling law');

    const listed = await (await fixture.api('/api/governance/proposals')).json() as { id: string; managerId: string; status: string }[];

    expect(listed.map(({ id, managerId, status }) => ({ id, managerId, status }))).toEqual([
      { id: fromLead, managerId: fixture.lead.id, status: 'pending' },
      { id: fromSibling, managerId: fixture.siblingLead.id, status: 'pending' },
    ]);
  });

  it('lists only the denied proposals, with their reason, for ?status=denied', async () => {
    const denied = await proposeLaw(lead, 'To deny');
    await proposeLaw(lead, 'Stays pending');
    await decide(denied, { decision: 'deny', reason: 'too vague' });

    const listed = await (await fixture.api('/api/governance/proposals?status=denied')).json() as { id: string; status: string; denialReason: string }[];

    expect(listed.map(({ id, status, denialReason }) => ({ id, status, denialReason }))).toEqual([{ id: denied, status: 'denied', denialReason: 'too vague' }]);
  });

  it('refuses an unknown status with invalid_body', async () => {
    const response = await fixture.api('/api/governance/proposals?status=bogus');

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
  });
});

describe('POST /api/governance/proposals/:id/decide', () => {
  it('approves a resource access: the manager sees the grant and the proposal leaves pending', async () => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');
    const { request_id } = await call(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident: 'need it' });

    const response = await decide(request_id, { decision: 'approve' });

    expect(response.status).toBe(200);
    const governance = await governanceOf(lead);
    expect(governance.pending).toEqual([]);
    expect(governance.resourceGrants).toHaveLength(1);
    expect(governance.resourceGrants[0]).toMatchObject({ resourceType: 'note', resourceId: noteId, access: 'read', role: 'reference', proposalId: request_id });
  });

  it('approves a law without creating a grant and without touching the mission note, byte for byte', async () => {
    const missionNoteId = await fixture.createNote(OWN_PROJECT_ID, 'Mission', '# Laws\n\n- Keep it small\n');
    await fixture.api(`/api/managers/${fixture.lead.id}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId }) });
    const missionStateOf = () => ({
      managerRow: JSON.stringify(fixture.db.prepare('SELECT * FROM managers WHERE session_id = ?').get(fixture.lead.id)),
      noteRows: JSON.stringify(fixture.db.prepare('SELECT * FROM notes ORDER BY id').all()),
      body: Buffer.from((fixture.db.prepare('SELECT body_md FROM notes WHERE id = ?').get(missionNoteId) as { body_md: string }).body_md),
    });
    const lawId = await proposeLaw(lead, 'Never force-push');
    const before = missionStateOf();

    const response = await decide(lawId, { decision: 'approve' });

    expect(response.status).toBe(200);
    const governance = await governanceOf(lead);
    expect(governance.resourceGrants).toEqual([]);
    expect(governance.pending).toEqual([]);
    expect(governance.history).toMatchObject([{ request_id: lawId, status: 'approved', text: 'Never force-push' }]);
    const after = missionStateOf();
    expect(after.body.equals(before.body)).toBe(true);
    expect(after.noteRows).toBe(before.noteRows);
    expect(after.managerRow).toBe(before.managerRow);
  });

  it('refuses a denial without a reason (invalid_body) and leaves the proposal pending', async () => {
    const lawId = await proposeLaw(lead);

    const response = await decide(lawId, { decision: 'deny' });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it.each([['an empty reason', ''], ['a blank reason', '   '], ['a reason over 500 characters', 'x'.repeat(501)]])('refuses a denial with %s', async (_label, reason) => {
    const lawId = await proposeLaw(lead);

    const response = await decide(lawId, { decision: 'deny', reason });

    expect(response.status).toBe(400);
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it('denies with a reason: the manager reads it in denied', async () => {
    const lawId = await proposeLaw(lead);

    const response = await decide(lawId, { decision: 'deny', reason: 'already covered by the mission note' });

    expect(response.status).toBe(200);
    const governance = await governanceOf(lead);
    expect(governance.pending).toEqual([]);
    expect(governance.denied).toMatchObject([{ request_id: lawId, reason: 'already covered by the mission note' }]);
  });

  it('refuses an unknown decision with invalid_body', async () => {
    const lawId = await proposeLaw(lead);

    const response = await decide(lawId, { decision: 'maybe' });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
  });

  it('answers a second decision with 409 already_resolved and keeps the first one', async () => {
    const lawId = await proposeLaw(lead);
    await decide(lawId, { decision: 'approve' });

    const second = await decide(lawId, { decision: 'deny', reason: 'changed my mind' });

    expect(second.status).toBe(409);
    expect((await errorOf(second)).error).toBe('already_resolved');
    expect((await governanceOf(lead)).history).toMatchObject([{ request_id: lawId, status: 'approved' }]);
  });

  it('answers an unknown id with 404 proposal_not_found', async () => {
    const response = await decide('no-such-proposal', { decision: 'approve' });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe('proposal_not_found');
  });

  it('records exactly one grant when an access is approved, and none when it is approved twice', async () => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');
    const { request_id } = await call(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident: 'need it' });

    await decide(request_id, { decision: 'approve' });
    await decide(request_id, { decision: 'approve' });

    expect(fixture.db.prepare('SELECT count(*) AS count FROM governance_resource_grants').get()).toEqual({ count: 1 });
  });

  it('refuses the session MCP token with 401 unauthorized and decides nothing', async () => {
    const lawId = await proposeLaw(lead);
    const mcpToken = (fixture.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(fixture.lead.id) as { mcp_token: string }).mcp_token;

    const response = await decide(lawId, { decision: 'approve' }, { authorization: `Bearer ${mcpToken}` });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).error).toBe('unauthorized');
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it('refuses a request without any token with 401 unauthorized', async () => {
    const lawId = await proposeLaw(lead);

    const response = await decide(lawId, { decision: 'approve' }, { authorization: '' });

    expect(response.status).toBe(401);
  });

  it('takes no decision when the session token posts to a decide path under /mcp', async () => {
    const lawId = await proposeLaw(lead);

    const response = await fetch(`${fixture.daemon.server.url}/mcp/governance/proposals/${lawId}/decide`, {
      method: 'POST', body: JSON.stringify({ decision: 'approve' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionTokenOf(fixture.lead.id)}` },
    });

    expect(response.status).toBe(404);
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it.each([['a number', 123], ['null', null], ['an object', { text: 'x' }]])('refuses a denial whose reason is %s with 400 invalid_body', async (_label, reason) => {
    const lawId = await proposeLaw(lead);

    const response = await decide(lawId, { decision: 'deny', reason });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it('answers 400 invalid_body, not 404, to a denial without reason on an unknown id: the body is checked before the proposal is looked up', async () => {
    const response = await decide('no-such-proposal', { decision: 'deny' });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe('invalid_body');
  });

  it('lets exactly one of two concurrent decisions win: one 200, one 409 already_resolved', async () => {
    const lawId = await proposeLaw(lead);
    const { frames } = await openClient();

    const responses = await Promise.all([decide(lawId, { decision: 'approve' }), decide(lawId, { decision: 'deny', reason: 'no' })]);
    await settle();

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const loser = responses.find(({ status }) => status === 409)!;
    expect((await errorOf(loser)).error).toBe('already_resolved');
    expect(frames.filter((frame) => frame.type === 'governance.resolved')).toHaveLength(1);
  });

  it('keeps a resource access pending, and silent on the WebSocket, when its resource has disappeared', async () => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');
    const { request_id } = await call(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident: 'need it' });
    fixture.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    const { frames } = await openClient();

    const response = await decide(request_id, { decision: 'approve' });
    await settle();

    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe('not_found');
    expect((await governanceOf(lead)).pending).toHaveLength(1);
    expect(frames.filter((frame) => frame.type.startsWith('governance.'))).toEqual([]);
    const { frames: laterFrames } = await openClient();
    const snapshot = laterFrames.find((frame) => frame.type === 'snapshot')!;
    expect(snapshot.proposals.map((proposal: { id: string }) => proposal.id)).toEqual([request_id]);
  });
});

describe('the admin token protects every governance route', () => {
  const protectedRoutes = [
    { label: 'GET /api/governance/proposals', method: 'GET', path: () => '/api/governance/proposals' },
    { label: 'GET /api/managers/:id/governance', method: 'GET', path: () => `/api/managers/${fixture.lead.id}/governance` },
    { label: 'POST /api/governance/proposals/:id/decide', method: 'POST', path: () => '/api/governance/proposals/any-id/decide' },
  ];
  const credentials = [
    { label: 'the session MCP token', authorization: () => `Bearer ${sessionTokenOf(fixture.lead.id)}` },
    { label: 'no authorization header', authorization: () => undefined },
    { label: 'an empty authorization header', authorization: () => '' },
  ];

  for (const route of protectedRoutes) {
    it.each(credentials)(`refuses ${route.label} with $label: 401 unauthorized`, async ({ authorization }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const header = authorization();
      if (header !== undefined) headers.authorization = header;

      const response = await fetch(`${fixture.daemon.server.url}${route.path()}`, {
        method: route.method, headers, body: route.method === 'POST' ? JSON.stringify({ decision: 'approve' }) : undefined,
      });

      expect(response.status).toBe(401);
      expect((await errorOf(response)).error).toBe('unauthorized');
    });
  }
});

describe('GET /api/managers/:id/governance', () => {
  it("returns the manager's whole governance view", async () => {
    const approved = await proposeLaw(lead, 'Approved law');
    const denied = await proposeLaw(lead, 'Denied law');
    const pending = await proposeLaw(lead, 'Pending law');
    await decide(approved, { decision: 'approve' });
    await decide(denied, { decision: 'deny', reason: 'no' });

    const view = await (await fixture.api(`/api/managers/${fixture.lead.id}/governance`)).json() as Record<string, any>;

    expect(view.pending.map((proposal: { id: string }) => proposal.id)).toEqual([pending]);
    expect(view.denied.map((proposal: { id: string }) => proposal.id)).toEqual([denied]);
    expect(view.history.map((proposal: { id: string }) => proposal.id)).toEqual([approved]);
    expect(view).toMatchObject({ resourceGrants: [], governanceEvictedDenials: 0 });
  });

  it('answers 404 manager_not_found for an unknown id', async () => {
    const response = await fixture.api('/api/managers/no-such-manager/governance');

    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe('manager_not_found');
  });

  it('answers 404 manager_not_found for a session that is not a manager', async () => {
    const response = await fixture.api(`/api/managers/${fixture.worker.id}/governance`);

    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe('manager_not_found');
  });
});

describe('governance events over the WebSocket', () => {
  it('broadcasts governance.proposed once when a manager proposes', async () => {
    const { frames } = await openClient();

    const lawId = await proposeLaw(lead);
    await waitForFrame(frames, (frame) => frame.type === 'governance.proposed');
    await settle();

    const proposed = frames.filter((frame) => frame.type === 'governance.proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.proposal).toMatchObject({ id: lawId, managerId: fixture.lead.id, kind: 'law', status: 'pending' });
  });

  it('does not broadcast again when an identical pending proposal is deduplicated', async () => {
    const { frames } = await openClient();
    await proposeLaw(lead);
    await proposeLaw(lead);
    await settle();

    expect(frames.filter((frame) => frame.type === 'governance.proposed')).toHaveLength(1);
  });

  it('broadcasts governance.resolved once with the answered proposal when a human decides', async () => {
    const lawId = await proposeLaw(lead);
    const { frames } = await openClient();

    await decide(lawId, { decision: 'deny', reason: 'no' });
    await waitForFrame(frames, (frame) => frame.type === 'governance.resolved');
    await settle();

    const resolved = frames.filter((frame) => frame.type === 'governance.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.proposal).toMatchObject({ id: lawId, status: 'denied', denialReason: 'no' });
  });

  it('broadcasts governance.resolved when the manager withdraws its own proposal', async () => {
    const lawId = await proposeLaw(lead);
    const { frames } = await openClient();

    await call(lead, 'withdraw_proposal', { request_id: lawId });

    const resolved = await waitForFrame(frames, (frame) => frame.type === 'governance.resolved');
    expect(resolved.proposal).toMatchObject({ id: lawId, status: 'withdrawn' });
  });

  it('broadcasts nothing when a decision is refused', async () => {
    const lawId = await proposeLaw(lead);
    await decide(lawId, { decision: 'approve' });
    const { frames } = await openClient();

    await decide(lawId, { decision: 'approve' });
    await decide('no-such-proposal', { decision: 'approve' });
    await decide(lawId, { decision: 'deny' });
    await settle();

    expect(frames.filter((frame) => frame.type.startsWith('governance.'))).toEqual([]);
  });

  it('sends governance.proposed before governance.resolved on the same client', async () => {
    const { frames } = await openClient();

    const lawId = await proposeLaw(lead);
    await decide(lawId, { decision: 'approve' });
    await waitForFrame(frames, (frame) => frame.type === 'governance.resolved');

    expect(frames.map((frame) => frame.type).filter((type) => type.startsWith('governance.'))).toEqual(['governance.proposed', 'governance.resolved']);
  });

  it('broadcasts nothing when the queue is full', async () => {
    for (let index = 0; index < 60; index += 1) await proposeLaw(lead, `Law ${index}`);
    const { frames } = await openClient();

    const refusal = await lead.callTool({ name: 'propose_law', arguments: { body: 'One too many', incident: 'x' } }) as { isError?: boolean };
    await settle();

    expect(refusal.isError).toBe(true);
    expect(frames.filter((frame) => frame.type.startsWith('governance.'))).toEqual([]);
  });

  it("broadcasts nothing when a manager withdraws another manager's proposal", async () => {
    const siblingLawId = await proposeLaw(siblingLead, 'Sibling law');
    const { frames } = await openClient();

    const refusal = await lead.callTool({ name: 'withdraw_proposal', arguments: { request_id: siblingLawId } }) as { isError?: boolean };
    await settle();

    expect(refusal.isError).toBe(true);
    expect((await governanceOf(siblingLead)).pending).toHaveLength(1);
    expect(frames.filter((frame) => frame.type.startsWith('governance.'))).toEqual([]);
  });

  it('puts the pending proposals, and only them, in the snapshot of a client that connects later', async () => {
    const stillPending = await proposeLaw(lead, 'Still pending');
    const approved = await proposeLaw(lead, 'Approved');
    await decide(approved, { decision: 'approve' });

    const { frames } = await openClient();

    const snapshot = frames.find((frame) => frame.type === 'snapshot')!;
    expect(snapshot.proposals.map((proposal: { id: string }) => proposal.id)).toEqual([stillPending]);
  });
});
