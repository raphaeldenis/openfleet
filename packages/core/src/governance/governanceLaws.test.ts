import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MAX_LAWS_RESPONSE_BYTES, MAX_LAW_TEXT_CHARS } from '@openfleet/shared';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { startGovernanceFixture, type GovernanceFixture } from './governanceQueue.testkit.js';

interface LawOfAgent { id: string; text: string; revision: number; createdAt: string; updatedAt: string; source: string }
interface LawOfAdmin extends LawOfAgent { managerId: string; status: string; approvedBy?: string; withdrawnAt?: string }

let fixture: GovernanceFixture;
let lead: Client;
let siblingLead: Client;

beforeEach(async () => {
  fixture = await startGovernanceFixture();
  [lead, siblingLead] = await Promise.all([fixture.connect(fixture.lead.id), fixture.connect(fixture.siblingLead.id)]);
});
afterEach(async () => { await fixture.close(); });

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text) as Record<string, any>;
const governanceOf = (client: Client) => call(client, 'get_argus_governance');
const lawsOf = async (client: Client) => (await governanceOf(client)).laws as LawOfAgent[];
const proposeLaw = async (client: Client, body = 'Never force-push') => (await call(client, 'propose_law', { body, incident: 'force push on main' })).request_id as string;
const decide = (proposalId: string, body: unknown) => fixture.api(`/api/governance/proposals/${proposalId}/decide`, { method: 'POST', body: JSON.stringify(body) });
const approve = (proposalId: string) => decide(proposalId, { decision: 'approve' });
const approveNewLaw = async (client: Client, body: string) => { const id = await proposeLaw(client, body); await approve(id); return id; };
const restLawsOf = async (managerId: string) => ((await (await fixture.api(`/api/managers/${managerId}/governance`)).json()) as { laws: LawOfAdmin[] }).laws;
const lawRowCount = () => (fixture.db.prepare('SELECT count(*) AS n FROM laws').get() as { n: number }).n;

describe('a pending proposal of a law', () => {
  it('is not an active law, for the manager nor for the admin', async () => {
    await proposeLaw(lead);

    expect(await lawsOf(lead)).toEqual([]);
    expect(await restLawsOf(fixture.lead.id)).toEqual([]);
    expect(lawRowCount()).toBe(0);
  });

  it('is not a law either once it is denied or withdrawn', async () => {
    const denied = await proposeLaw(lead, 'To deny');
    const withdrawn = await proposeLaw(lead, 'To withdraw');

    await decide(denied, { decision: 'deny', reason: 'too vague' });
    await call(lead, 'withdraw_proposal', { request_id: withdrawn });

    expect(await lawsOf(lead)).toEqual([]);
    expect(lawRowCount()).toBe(0);
  });
});

describe('approving a proposal of a law', () => {
  it('creates one active law, with the proposal text, that the manager and the admin both read', async () => {
    const proposalId = await proposeLaw(lead, 'Close a session before opening one on a new branch');

    const response = await approve(proposalId);

    expect(response.status).toBe(200);
    expect(await lawsOf(lead)).toEqual([{
      id: expect.any(String), text: 'Close a session before opening one on a new branch', revision: 1,
      createdAt: expect.any(String), updatedAt: expect.any(String), source: 'proposal',
    }]);
    expect(await restLawsOf(fixture.lead.id)).toEqual([expect.objectContaining({
      managerId: fixture.lead.id, text: 'Close a session before opening one on a new branch', status: 'active', approvedBy: 'admin', proposalId,
    })]);
  });

  it('keeps every old key of get_argus_governance and adds the laws', async () => {
    await approveNewLaw(lead, 'A law');

    const governance = await governanceOf(lead);

    expect(Object.keys(governance).sort()).toEqual(['denied', 'governanceEvictedDenials', 'history', 'laws', 'note', 'pending', 'resourceGrants']);
    expect(governance.history).toEqual([expect.objectContaining({ kind: 'law', status: 'approved', text: 'A law' })]);
  });

  it('creates a single law when the same proposal is approved twice', async () => {
    const proposalId = await proposeLaw(lead);

    const first = await approve(proposalId);
    const second = await approve(proposalId);

    expect([first.status, second.status]).toEqual([200, 409]);
    expect(await lawsOf(lead)).toHaveLength(1);
  });

  it('creates a single law when two approvals race', async () => {
    const proposalId = await proposeLaw(lead);

    const answers = await Promise.all([approve(proposalId), approve(proposalId)]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(lawRowCount()).toBe(1);
  });

  it('is undone as a whole when the law cannot be recorded: the proposal stays pending and no law exists', async () => {
    const proposalId = await proposeLaw(lead);
    fixture.db.exec("CREATE TRIGGER law_insert_fails BEFORE INSERT ON laws BEGIN SELECT RAISE(ABORT, 'law insert fails'); END");

    const failed = await approve(proposalId);
    const pendingAfterFailure = await (await fixture.api('/api/governance/proposals?status=pending')).json() as { id: string }[];
    fixture.db.exec('DROP TRIGGER law_insert_fails');
    const retried = await approve(proposalId);

    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(pendingAfterFailure.map((proposal) => proposal.id)).toEqual([proposalId]);
    expect(retried.status).toBe(200);
    expect(await lawsOf(lead)).toHaveLength(1);
  });

  it('does not create a law for the approval of a resource access', async () => {
    const noteId = await fixture.createNote((fixture.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(fixture.lead.id) as { project_id: string }).project_id, 'Runbook');
    const { request_id } = await call(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident: 'need it' });

    await approve(request_id);

    expect(lawRowCount()).toBe(0);
  });
});

describe('the laws of a manager', () => {
  it('stay invisible to another manager, over MCP and over REST', async () => {
    await approveNewLaw(lead, 'The law of the lead');
    await approveNewLaw(siblingLead, 'The law of the sibling');

    expect((await lawsOf(lead)).map((law) => law.text)).toEqual(['The law of the lead']);
    expect((await lawsOf(siblingLead)).map((law) => law.text)).toEqual(['The law of the sibling']);
    expect((await restLawsOf(fixture.lead.id)).map((law) => law.text)).toEqual(['The law of the lead']);
  });

  it('are listed oldest first', async () => {
    await approveNewLaw(lead, 'First');
    await approveNewLaw(lead, 'Second');
    await approveNewLaw(lead, 'Third');

    expect((await lawsOf(lead)).map((law) => law.text)).toEqual(['First', 'Second', 'Third']);
  });

  it('are all kept after more decisions than the audit history holds', async () => {
    const decisions = 55;
    for (let index = 0; index < decisions; index += 1) await approveNewLaw(lead, `Law number ${index}`);

    const governance = await governanceOf(lead);

    expect(governance.history.length).toBeLessThan(decisions);
    expect(governance.laws).toHaveLength(decisions);
    expect(governance.laws[0].text).toBe('Law number 0');
  }, 30_000);

  it('show a withdrawn law to the admin with its status and hide it from the manager', async () => {
    await approveNewLaw(lead, 'Soon withdrawn');
    await approveNewLaw(lead, 'Stays');
    fixture.db.prepare("UPDATE laws SET status = 'withdrawn', withdrawn_at = 't9', withdrawn_by = 'admin' WHERE text = 'Soon withdrawn'").run();

    expect((await lawsOf(lead)).map((law) => law.text)).toEqual(['Stays']);
    expect((await restLawsOf(fixture.lead.id)).map(({ text, status }) => ({ text, status }))).toEqual([{ text: 'Soon withdrawn', status: 'withdrawn' }, { text: 'Stays', status: 'active' }]);
  });

  it('disappear with their manager', async () => {
    await approveNewLaw(lead, 'Goes with the lead');

    fixture.db.prepare('DELETE FROM managers WHERE session_id = ?').run(fixture.lead.id);

    expect(lawRowCount()).toBe(0);
  });
});

describe('the bounds of the laws in a response', () => {
  const insertLaws = (count: number, textLength: number) => {
    const insert = fixture.db.prepare(`INSERT INTO laws (id, manager_id, text, status, revision, created_at, updated_at, approved_by, updated_by, source_kind)
      VALUES (?, ?, ?, 'active', 1, ?, ?, 'admin', 'admin', 'proposal')`);
    for (let index = 0; index < count; index += 1) {
      const createdAt = `2026-10-20T10:00:${String(index % 60).padStart(2, '0')}.${String(Math.floor(index / 60)).padStart(3, '0')}Z`;
      insert.run(`law-${String(index).padStart(4, '0')}`, fixture.lead.id, `${String(index).padStart(4, '0')} ${'x'.repeat(textLength - 5)}`, createdAt, createdAt);
    }
  };

  it('holds a law of the longest allowed text whole, without truncation flags', async () => {
    insertLaws(1, MAX_LAW_TEXT_CHARS);

    const governance = await governanceOf(lead);

    expect(governance.laws[0].text).toHaveLength(MAX_LAW_TEXT_CHARS);
    expect(governance.lawsTruncated).toBeUndefined();
  });

  it('refuses at the database a law longer than the bound or blank', () => {
    expect(() => insertLaws(1, MAX_LAW_TEXT_CHARS + 1)).toThrow(/CHECK/);

    insertLaws(1, MAX_LAW_TEXT_CHARS);
    expect(() => fixture.db.prepare("UPDATE laws SET text = '   '").run()).toThrow(/CHECK/);
  });

  it('says it truncated, with the total, when the laws exceed the byte budget, and keeps whole laws only', async () => {
    const lawsThatOverflow = Math.ceil(MAX_LAWS_RESPONSE_BYTES / MAX_LAW_TEXT_CHARS) + 20;
    insertLaws(lawsThatOverflow, MAX_LAW_TEXT_CHARS);

    const governance = await governanceOf(lead);
    const shown = governance.laws as LawOfAgent[];

    expect(governance.lawsTruncated).toBe(true);
    expect(governance.lawsTotal).toBe(lawsThatOverflow);
    expect(shown.length).toBeLessThan(lawsThatOverflow);
    expect(Buffer.byteLength(JSON.stringify(shown), 'utf8')).toBeLessThanOrEqual(MAX_LAWS_RESPONSE_BYTES);
    expect(shown.every((law) => law.text.length === MAX_LAW_TEXT_CHARS)).toBe(true);
    expect(shown[0]!.text.startsWith('0000')).toBe(true);
  });

  it('gives the admin every law, untruncated', async () => {
    const lawsThatOverflow = Math.ceil(MAX_LAWS_RESPONSE_BYTES / MAX_LAW_TEXT_CHARS) + 20;
    insertLaws(lawsThatOverflow, MAX_LAW_TEXT_CHARS);

    expect(await restLawsOf(fixture.lead.id)).toHaveLength(lawsThatOverflow);
  });
});

describe('the laws across a daemon restart', () => {
  const directories = createTempDirTracker();
  afterEach(() => { directories.removeAll(); });

  it('keeps an approved law', async () => {
    const home = directories.make('governance-laws-restart-');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
    const options = { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` };
    const firstRun = await startDaemon(config, options);
    const workingDirectory = join(home, 'lead');
    mkdirSync(workingDirectory);
    const created = await fetch(`${firstRun.server.url}/api/sessions`, { method: 'POST', headers,
      body: JSON.stringify({ directory: workingDirectory, name: 'Lead', harness: 'fake', emoji: '🤖', manager: { childrenCap: 1, mission: 'x', pulseSeconds: 3600 } }) });
    const { id } = await created.json() as { id: string };
    const proposal = firstRun.governanceQueue.proposeLaw({ managerId: id, text: 'Survive the restart', incident: 'daemon restart' }).proposal;
    await fetch(`${firstRun.server.url}/api/governance/proposals/${proposal.id}/decide`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) });
    await firstRun.close();

    const secondRun = await startDaemon(config, options);
    const view = await (await fetch(`${secondRun.server.url}/api/managers/${id}/governance`, { headers })).json() as { laws: LawOfAdmin[] };
    await secondRun.close();

    expect(view.laws.map(({ text, status }) => ({ text, status }))).toEqual([{ text: 'Survive the restart', status: 'active' }]);
  });
});
