import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_AUDIT_HISTORY_PER_MANAGER, MAX_DENIED_HISTORY_PER_MANAGER, MAX_PENDING_PROPOSALS_PER_MANAGER } from '@openfleet/shared';
import { describeToolError } from '../mcp/toolResults.js';
import { startGovernanceFixture, OTHER_PROJECT_ID, OWN_PROJECT_ID, type GovernanceFixture } from './governanceQueue.testkit.js';

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

const refusalCodeOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return describeToolError(error).error;
  }
  return undefined;
};

const leadId = () => fixture.lead.id;
const proposeLaw = (text: string, managerId = leadId()) => fixture.governanceQueue.proposeLaw({ managerId, text, incident: 'it happened again' });
const proposeAccess = (resourceId: string, overrides: { access?: string; role?: string; resourceType?: string } = {}) =>
  fixture.governanceQueue.requestResourceAccess({ managerId: leadId(), resourceType: overrides.resourceType ?? 'dataStore', resourceId, access: overrides.access ?? 'read', role: overrides.role ?? 'reader', incident: 'needs the numbers' });
const viewOfLead = () => fixture.governanceQueue.viewOf(leadId());
const approve = (proposalId: string) => fixture.governanceQueue.decide({ proposalId, decision: 'approve' });
const deny = (proposalId: string, reason = 'not now') => fixture.governanceQueue.decide({ proposalId, decision: 'deny', reason });

describe('the governance queue of a booted daemon', () => {
  it('is the service the MCP tools of the same daemon write to', async () => {
    const client = await fixture.connect(leadId());

    await client.callTool({ name: 'propose_law', arguments: { body: 'Never force-push', incident: 'force push on main' } });

    expect(viewOfLead().pending.map((proposal) => proposal.payload)).toEqual([{ text: 'Never force-push' }]);
  });
});

describe('a pending proposal', () => {
  it('grants nothing: no grant row, no change to the manager mission', async () => {
    const missionBefore = fixture.db.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(leadId());
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');

    proposeLaw('Ask before deleting');
    proposeAccess(noteId, { resourceType: 'note' });

    expect(viewOfLead().resourceGrants).toEqual([]);
    expect(fixture.db.prepare('SELECT count(*) AS n FROM governance_resource_grants').get()).toEqual({ n: 0 });
    expect(fixture.db.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(leadId())).toEqual(missionBefore);
  });

  it('is listed as pending with its incident and its text', () => {
    const { proposal } = proposeLaw('Ask before deleting');

    expect(viewOfLead().pending).toEqual([expect.objectContaining({ id: proposal.id, kind: 'law', status: 'pending', incident: 'it happened again', payload: { text: 'Ask before deleting' } })]);
  });
});

describe('the pending cap', () => {
  it('refuses the proposal past the cap with governance_queue_full, and takes it again once one is withdrawn', () => {
    const proposals = Array.from({ length: MAX_PENDING_PROPOSALS_PER_MANAGER }, (_, index) => proposeLaw(`Law number ${index}`).proposal);

    const refusal = refusalCodeOf(() => proposeLaw('One law too many'));
    fixture.governanceQueue.withdraw({ managerId: leadId(), proposalId: proposals[0]!.id });
    const retried = refusalCodeOf(() => proposeLaw('One law too many'));

    expect(refusal).toBe('governance_queue_full');
    expect(retried).toBeUndefined();
  });

  it('counts every kind of proposal together', async () => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');
    for (let index = 0; index < MAX_PENDING_PROPOSALS_PER_MANAGER - 1; index++) proposeLaw(`Law number ${index}`);
    fixture.governanceQueue.proposePermission({ managerId: leadId(), action: 'deploy', scope: 'staging', condition: 'green CI', exclusions: 'friday', incident: 'late deploy' });

    expect(refusalCodeOf(() => proposeAccess(noteId, { resourceType: 'note' }))).toBe('governance_queue_full');
  });

  it('counts the queue of each manager on its own', () => {
    for (let index = 0; index < MAX_PENDING_PROPOSALS_PER_MANAGER; index++) proposeLaw(`Law number ${index}`);

    expect(refusalCodeOf(() => proposeLaw('A sibling law', fixture.siblingLead.id))).toBeUndefined();
  });

  it('does not count a proposal already answered', () => {
    for (let index = 0; index < MAX_PENDING_PROPOSALS_PER_MANAGER; index++) approve(proposeLaw(`Law number ${index}`).proposal.id);

    expect(refusalCodeOf(() => proposeLaw('A fresh law'))).toBeUndefined();
  });
});

describe('the same pending proposal proposed again', () => {
  it('answers the id it already has, flagged deduplicated, and takes no place in the queue', () => {
    const first = proposeLaw('Ask before deleting');
    for (let index = 1; index < MAX_PENDING_PROPOSALS_PER_MANAGER; index++) proposeLaw(`Law number ${index}`);

    const again = proposeLaw('Ask before deleting');

    expect(first.deduplicated).toBe(false);
    expect(again).toMatchObject({ deduplicated: true, proposal: { id: first.proposal.id } });
    expect(viewOfLead().pending).toHaveLength(MAX_PENDING_PROPOSALS_PER_MANAGER);
  });

  it('is a new proposal once the first one is answered', () => {
    const first = proposeLaw('Ask before deleting');
    deny(first.proposal.id);

    const again = proposeLaw('Ask before deleting');

    expect(again).toMatchObject({ deduplicated: false });
    expect(again.proposal.id).not.toBe(first.proposal.id);
  });

  it('is not a duplicate of a proposal of another manager', () => {
    const first = proposeLaw('Ask before deleting');

    const sibling = proposeLaw('Ask before deleting', fixture.siblingLead.id);

    expect(sibling.deduplicated).toBe(false);
    expect(sibling.proposal.id).not.toBe(first.proposal.id);
  });
});

describe('the denied history', () => {
  it('keeps the newest denials, drops the oldest one and declares the eviction', () => {
    const reasons = Array.from({ length: MAX_DENIED_HISTORY_PER_MANAGER + 1 }, (_, index) => `reason ${index}`);

    reasons.forEach((reason, index) => deny(proposeLaw(`Law number ${index}`).proposal.id, reason));

    const view = viewOfLead();
    expect(view.denied).toHaveLength(MAX_DENIED_HISTORY_PER_MANAGER);
    expect(view.denied.map((proposal) => proposal.denialReason)).not.toContain('reason 0');
    expect(view.denied.map((proposal) => proposal.denialReason)).toContain('reason 1');
    expect(view.governanceEvictedDenials).toBe(1);
  });

  it('declares nothing while the history holds every denial', () => {
    deny(proposeLaw('Only one').proposal.id);

    expect(viewOfLead().governanceEvictedDenials).toBe(0);
  });
});

describe('the approved and withdrawn history', () => {
  it('keeps the newest entries and drops the oldest ones without a counter', () => {
    for (let index = 0; index < MAX_AUDIT_HISTORY_PER_MANAGER + 2; index++) approve(proposeLaw(`Law number ${index}`).proposal.id);

    const view = viewOfLead();
    expect(view.history).toHaveLength(MAX_AUDIT_HISTORY_PER_MANAGER);
    expect(view.governanceEvictedDenials).toBe(0);
  });

  it('lists a withdrawn proposal as withdrawn', () => {
    const { proposal } = proposeLaw('Changed my mind');

    fixture.governanceQueue.withdraw({ managerId: leadId(), proposalId: proposal.id });

    expect(viewOfLead().history).toEqual([expect.objectContaining({ id: proposal.id, status: 'withdrawn' })]);
    expect(viewOfLead().pending).toEqual([]);
  });
});

describe('deciding a proposal', () => {
  it('creates exactly one grant when a resource access is approved', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');
    const { proposal } = proposeAccess(tableId, { access: 'readWrite', role: 'analyst' });

    approve(proposal.id);

    expect(viewOfLead().resourceGrants).toEqual([expect.objectContaining({ resourceType: 'dataStore', resourceId: tableId, access: 'readWrite', role: 'analyst', proposalId: proposal.id })]);
    expect(viewOfLead().history).toEqual([expect.objectContaining({ id: proposal.id, status: 'approved' })]);
  });

  it('creates no grant when a law or a permission is approved', () => {
    approve(proposeLaw('Ask before deleting').proposal.id);
    approve(fixture.governanceQueue.proposePermission({ managerId: leadId(), action: 'deploy', scope: 'staging', condition: 'green CI', exclusions: 'friday', incident: 'late' }).proposal.id);

    expect(viewOfLead().resourceGrants).toEqual([]);
    expect(viewOfLead().history).toHaveLength(2);
  });

  it('writes nothing in the mission of the manager when a law is approved', () => {
    const missionBefore = fixture.db.prepare('SELECT mission_text, mission_note_id FROM managers WHERE session_id = ?').get(leadId());

    approve(proposeLaw('Ask before deleting').proposal.id);

    expect(fixture.db.prepare('SELECT mission_text, mission_note_id FROM managers WHERE session_id = ?').get(leadId())).toEqual(missionBefore);
  });

  it('replaces the grant of a resource when a second access is approved on it', async () => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Playbook');
    approve(proposeAccess(noteId, { resourceType: 'note', access: 'read', role: 'reader' }).proposal.id);

    approve(proposeAccess(noteId, { resourceType: 'note', access: 'append', role: 'scribe' }).proposal.id);

    expect(viewOfLead().resourceGrants).toEqual([expect.objectContaining({ resourceId: noteId, access: 'append', role: 'scribe' })]);
  });

  it('keeps the denial reason and creates no grant when a resource access is denied', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');
    const { proposal } = proposeAccess(tableId);

    deny(proposal.id, 'too broad');

    expect(viewOfLead().denied).toEqual([expect.objectContaining({ id: proposal.id, status: 'denied', denialReason: 'too broad' })]);
    expect(viewOfLead().resourceGrants).toEqual([]);
  });

  it('answers already_resolved to a second decision and changes nothing', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');
    const { proposal } = proposeAccess(tableId);
    approve(proposal.id);

    const secondDecisions = [refusalCodeOf(() => approve(proposal.id)), refusalCodeOf(() => deny(proposal.id))];

    expect(secondDecisions).toEqual(['already_resolved', 'already_resolved']);
    expect(viewOfLead().resourceGrants).toHaveLength(1);
    expect(viewOfLead().denied).toEqual([]);
  });

  it('answers already_resolved to the withdrawal of a proposal that is not pending', () => {
    const { proposal } = proposeLaw('Ask before deleting');
    approve(proposal.id);

    expect(refusalCodeOf(() => fixture.governanceQueue.withdraw({ managerId: leadId(), proposalId: proposal.id }))).toBe('already_resolved');
  });

  it('answers already_resolved to a decision on a withdrawn proposal', () => {
    const { proposal } = proposeLaw('Ask before deleting');
    fixture.governanceQueue.withdraw({ managerId: leadId(), proposalId: proposal.id });

    expect(refusalCodeOf(() => approve(proposal.id))).toBe('already_resolved');
  });

  it('answers proposal_not_found to an id nobody proposed', () => {
    expect(refusalCodeOf(() => approve('no-such-proposal'))).toBe('proposal_not_found');
  });

  it.each([
    ['no reason', undefined],
    ['a blank reason', '   '],
    ['a reason past 500 characters', 'x'.repeat(501)],
  ])('refuses a denial with %s and leaves the proposal pending', (_label, reason) => {
    const { proposal } = proposeLaw('Ask before deleting');

    const code = refusalCodeOf(() => fixture.governanceQueue.decide({ proposalId: proposal.id, decision: 'deny', reason }));

    expect(code).toBe('invalid_body');
    expect(viewOfLead().pending).toHaveLength(1);
  });

  it('is all or nothing: an approval whose table is gone fails and leaves the proposal pending without grant', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');
    const { proposal } = proposeAccess(tableId);
    fixture.db.prepare('DELETE FROM data_stores WHERE id = ?').run(tableId);

    const code = refusalCodeOf(() => approve(proposal.id));

    expect(code).toBe('store_not_found');
    expect(viewOfLead().pending).toEqual([expect.objectContaining({ id: proposal.id, status: 'pending' })]);
    expect(viewOfLead().resourceGrants).toEqual([]);
  });

  it('lets a human deny what can no longer be approved', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');
    const { proposal } = proposeAccess(tableId);
    fixture.db.prepare('DELETE FROM data_stores WHERE id = ?').run(tableId);

    deny(proposal.id, 'the table is gone');

    expect(viewOfLead().denied).toHaveLength(1);
  });

  it('decides a proposal of a closed manager', async () => {
    const { proposal } = proposeLaw('Ask before deleting');
    fixture.db.prepare("UPDATE sessions SET state = 'closed' WHERE id = ?").run(leadId());

    approve(proposal.id);

    expect(viewOfLead().history).toEqual([expect.objectContaining({ id: proposal.id, status: 'approved' })]);
  });
});

describe('a manager and the proposals of another', () => {
  it('sees only its own proposals', () => {
    proposeLaw('Law of the lead');
    proposeLaw('Law of the sibling', fixture.siblingLead.id);

    expect(viewOfLead().pending.map((proposal) => proposal.payload)).toEqual([{ text: 'Law of the lead' }]);
  });

  it('cannot withdraw the proposal of another manager, and gets the very answer of a missing id', () => {
    const { proposal } = proposeLaw('Law of the lead');

    const foreign = refusalCodeOf(() => fixture.governanceQueue.withdraw({ managerId: fixture.siblingLead.id, proposalId: proposal.id }));
    const missing = refusalCodeOf(() => fixture.governanceQueue.withdraw({ managerId: fixture.siblingLead.id, proposalId: 'no-such-proposal' }));

    expect(foreign).toBe('proposal_not_found');
    expect(missing).toBe('proposal_not_found');
    expect(viewOfLead().pending).toHaveLength(1);
  });

  it('gets the same message for a proposal of another manager and for a missing one', () => {
    const { proposal } = proposeLaw('Law of the lead');
    const messageOf = (proposalId: string) => {
      try { fixture.governanceQueue.withdraw({ managerId: fixture.siblingLead.id, proposalId }); } catch (error) { return describeToolError(error).message; }
      return undefined;
    };

    expect(messageOf(proposal.id)).toBe(messageOf('no-such-proposal'));
  });
});

describe('a session that is not a manager', () => {
  it('proposes nothing, withdraws nothing and sees nothing: not_a_manager', () => {
    const workerId = fixture.worker.id;

    const codes = [
      refusalCodeOf(() => fixture.governanceQueue.proposeLaw({ managerId: workerId, text: 'x', incident: 'y' })),
      refusalCodeOf(() => fixture.governanceQueue.withdraw({ managerId: workerId, proposalId: 'p' })),
      refusalCodeOf(() => fixture.governanceQueue.viewOf(workerId)),
    ];

    expect(codes).toEqual(['not_a_manager', 'not_a_manager', 'not_a_manager']);
  });
});

describe('what a proposal may say', () => {
  it.each([
    ['an empty incident', { incident: '' }],
    ['a blank incident', { incident: '   ' }],
    ['an incident past 1000 characters', { incident: 'i'.repeat(1001) }],
    ['an empty law', { text: '' }],
    ['a law past 2000 characters', { text: 't'.repeat(2001) }],
  ])('refuses a law with %s and queues nothing', (_label, fields) => {
    const code = refusalCodeOf(() => fixture.governanceQueue.proposeLaw({ managerId: leadId(), text: 'a law', incident: 'an incident', ...fields }));

    expect(code).toBe('invalid_body');
    expect(viewOfLead().pending).toEqual([]);
  });

  it.each(['action', 'scope', 'condition', 'exclusions'])('refuses a permission whose %s is blank', (field) => {
    const code = refusalCodeOf(() => fixture.governanceQueue.proposePermission({ managerId: leadId(), action: 'deploy', scope: 'staging', condition: 'green CI', exclusions: 'friday', incident: 'late', [field]: '  ' }));

    expect(code).toBe('invalid_body');
  });

  it('refuses a permission field past 500 characters', () => {
    const code = refusalCodeOf(() => fixture.governanceQueue.proposePermission({ managerId: leadId(), action: 'deploy', scope: 's'.repeat(501), condition: 'green CI', exclusions: 'friday', incident: 'late' }));

    expect(code).toBe('invalid_body');
  });

  it('masks a secret written in the incident and in the text before storing it', () => {
    const secret = 'Bearer abcdef1234567890SECRETvalue';

    fixture.governanceQueue.proposeLaw({ managerId: leadId(), text: `Never paste ${secret} anywhere`, incident: `the agent printed ${secret}` });

    const stored = JSON.stringify(fixture.db.prepare('SELECT incident, payload_json FROM governance_proposals').all());
    expect(stored).not.toContain('abcdef1234567890SECRETvalue');
    expect(stored).toContain('***');
  });
});

describe('a resource access request', () => {
  it.each([
    ['an unknown resource type', { resourceType: 'folder' }],
    ['an unknown access', { access: 'admin' }],
    ['an append on a table', { access: 'append' }],
    ['a run on a table', { access: 'run' }],
    ['a blank role', { role: '  ' }],
    ['a role past 80 characters', { role: 'r'.repeat(81) }],
  ])('refuses %s', async (_label, overrides) => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');

    expect(refusalCodeOf(() => proposeAccess(tableId, overrides))).toBe('invalid_body');
    expect(viewOfLead().pending).toEqual([]);
  });

  it.each(['playbook', 'integration'])('refuses a %s: OpenFleet has no such registry yet', (resourceType) => {
    const access = resourceType === 'playbook' ? 'run' : 'use';

    expect(refusalCodeOf(() => proposeAccess('anything', { resourceType, access }))).toBe('invalid_body');
  });

  it('answers a table of another project and a missing table with the very same refusal', async () => {
    const foreignTableId = await fixture.createTable(OTHER_PROJECT_ID, 'Foreign');
    const wordsOf = (resourceId: string) => { try { proposeAccess(resourceId); } catch (error) { return describeToolError(error); } return undefined; };

    expect(wordsOf(foreignTableId)).toMatchObject({ error: 'store_not_found' });
    expect(wordsOf(foreignTableId)).toEqual(wordsOf('no-such-table'));
  });

  it('answers a note of another project with note_not_found', async () => {
    const foreignNoteId = await fixture.createNote(OTHER_PROJECT_ID, 'Foreign note');

    expect(refusalCodeOf(() => proposeAccess(foreignNoteId, { resourceType: 'note' }))).toBe('note_not_found');
  });
});
