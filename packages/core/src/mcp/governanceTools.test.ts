import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { startGovernanceFixture, OTHER_PROJECT_ID, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

let fixture: GovernanceFixture;
let lead: Client;
let siblingLead: Client;
let worker: Client;
beforeEach(async () => {
  fixture = await startGovernanceFixture();
  [lead, siblingLead, worker] = await Promise.all([fixture.connect(fixture.lead.id), fixture.connect(fixture.siblingLead.id), fixture.connect(fixture.worker.id)]);
});
afterEach(async () => { await fixture.close(); });

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true;
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const jsonOf = (result: unknown) => JSON.parse(textOf(result)) as Record<string, any>;
const governanceOf = async (client: Client) => jsonOf(await call(client, 'get_argus_governance'));

const permission = { action: 'reap worktrees', scope: 'idle worktrees', condition: 'load below 30', exclusions: 'dirty worktrees', incident: 'disk full' };
const law = { body: 'Never force-push', incident: 'force push on main' };
const INVISIBLE_TEXTS = [
  ['an empty text', ''],
  ['spaces', '  '],
  ['zero-width characters', '​‌‍⁠'],
  ['a braille blank', '⠀'],
  ['hangul fillers', 'ㅤᅟ'],
  ['bidi controls', '‪‮⁦⁩'],
  ['control characters', '\u0000\u0007\u007f'],
  ['an ANSI colour sequence', '\u001b[31m\u001b[0m'],
  ['line and paragraph separators', '  '],
  ['unicode spaces, newlines and tabs', '   \n\t\r\n'],
] as const;
const BLANK_INCIDENTS = INVISIBLE_TEXTS.map(([, text]) => text);

describe('the five governance tools', () => {
  it('are offered to an agent with exactly the input properties of the Scape tools', async () => {
    const tools = (await lead.listTools()).tools;

    const inputPropertiesOf = (name: string) => Object.keys(tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {}).sort();

    expect(inputPropertiesOf('propose_law')).toEqual(['body', 'incident']);
    expect(inputPropertiesOf('propose_permission')).toEqual(['action', 'condition', 'exclusions', 'incident', 'scope']);
    expect(inputPropertiesOf('request_resource_access')).toEqual(['access', 'incident', 'resource_id', 'resource_type', 'role']);
    expect(inputPropertiesOf('withdraw_proposal')).toEqual(['request_id']);
    expect(inputPropertiesOf('get_argus_governance')).toEqual([]);
  });

  it('describe the incident the way each Scape tool does', async () => {
    const tools = (await lead.listTools()).tools;

    const incidentDescriptionOf = (name: string) => (tools.find((tool) => tool.name === name)?.inputSchema.properties?.incident as { description?: string } | undefined)?.description;

    expect(incidentDescriptionOf('propose_law')).toBe('REQUIRED. The triggering incident: a log-table row reference, ticket key, or a one-line description of what went wrong.');
    expect(incidentDescriptionOf('propose_permission')).toBe('REQUIRED. The triggering incident: log-table row reference, ticket key, or one-line description.');
    expect(incidentDescriptionOf('request_resource_access')).toBe('REQUIRED. What prompted this request: log-table row, ticket key, or one-line description.');
  });

  it('require the very same fields as the Scape tools', async () => {
    const tools = (await lead.listTools()).tools;

    const requiredOf = (name: string) => [...(tools.find((tool) => tool.name === name)?.inputSchema.required ?? [])].sort();

    expect(requiredOf('propose_law')).toEqual(['body', 'incident']);
    expect(requiredOf('propose_permission')).toEqual(['action', 'condition', 'exclusions', 'incident', 'scope']);
    expect(requiredOf('request_resource_access')).toEqual(['access', 'incident', 'resource_id', 'resource_type', 'role']);
    expect(requiredOf('withdraw_proposal')).toEqual(['request_id']);
  });
});

describe('a session that is not a manager', () => {
  it.each([
    ['propose_law', law],
    ['propose_permission', permission],
    ['request_resource_access', { resource_type: 'note', resource_id: 'n', access: 'read', role: 'ref', incident: 'x' }],
    ['withdraw_proposal', { request_id: 'p' }],
    ['get_argus_governance', {}],
  ])('is refused by %s with not_a_manager', async (name, args) => {
    const result = await call(worker, name, args);

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/^error not_a_manager: .* \(retry: never\)$/);
  });
});

describe('an incident that says nothing', () => {
  it.each(BLANK_INCIDENTS)('is refused by every proposing tool (incident %j) and leaves the governance state empty', async (incident) => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');

    const results = [
      await call(lead, 'propose_law', { ...law, incident }),
      await call(lead, 'propose_permission', { ...permission, incident }),
      await call(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident }),
    ];

    results.forEach((result) => expect(textOf(result)).toMatch(/^error invalid_body: /));
    expect(await governanceOf(lead)).toMatchObject({ pending: [], denied: [], history: [], resourceGrants: [] });
  });
});

describe.each(INVISIBLE_TEXTS)('a field made of %s only', (_label, invisibleText) => {
  const noteRequest = { resource_type: 'note', resource_id: 'a-note', access: 'read', role: 'reference', incident: 'need it' };
  it.each([
    ['propose_law', 'body', law],
    ['propose_permission', 'action', permission],
    ['propose_permission', 'scope', permission],
    ['propose_permission', 'condition', permission],
    ['propose_permission', 'exclusions', permission],
    ['request_resource_access', 'role', noteRequest],
    ['request_resource_access', 'resource_id', noteRequest],
  ])('is refused by %s as its %s (invalid_body) and queues nothing', async (tool, field, validArguments) => {
    const result = await call(lead, tool, { ...validArguments, [field]: invisibleText });

    expect(textOf(result)).toMatch(/^error invalid_body: /);
    expect(await governanceOf(lead)).toMatchObject({ pending: [], denied: [], history: [], resourceGrants: [] });
  });
});

describe('the text of a proposal', () => {
  it('is the same proposal whether or not it hides zero-width characters, and shows the clean text', async () => {
    const first = jsonOf(await call(lead, 'propose_law', law));

    const again = jsonOf(await call(lead, 'propose_law', { body: `Never​ force-push⁠`, incident: law.incident }));
    const governance = await governanceOf(lead);

    expect(again).toMatchObject({ request_id: first.request_id, deduplicated: true });
    expect(governance.pending).toEqual([expect.objectContaining({ text: law.body })]);
  });

  it('keeps the line breaks and tabs of a multi-line law, and drops what is invisible around it', async () => {
    await call(lead, 'propose_law', { body: '​ Rule one\n\tsub-rule‮\n ', incident: law.incident });

    expect((await governanceOf(lead)).pending).toEqual([expect.objectContaining({ text: 'Rule one\n\tsub-rule' })]);
  });

  it('shows an incident without its invisible characters', async () => {
    await call(lead, 'propose_law', { ...law, incident: '​disk‍ full\u001b[31m' });

    expect((await governanceOf(lead)).pending).toEqual([expect.objectContaining({ incident: 'disk full' })]);
  });
});

describe('propose_permission', () => {
  it('refuses a permission without exclusions: a permission without a bound is a blank cheque', async () => {
    const result = await call(lead, 'propose_permission', { ...permission, exclusions: '' });

    expect(textOf(result)).toMatch(/^error invalid_body: /);
  });

  it('acknowledges a permission with its four bounds by a request id, pending', async () => {
    const result = await call(lead, 'propose_permission', permission);

    expect(jsonOf(result)).toMatchObject({ request_id: expect.any(String), status: 'pending' });
  });
});

describe('propose_law then get_argus_governance', () => {
  it('shows the law as pending, grants nothing and leaves the mission note byte for byte as it was', async () => {
    const missionNoteId = await fixture.createNote(OWN_PROJECT_ID, 'Mission', '# Mission\n\n## Laws\n- be kind\n');
    await fixture.api(`/api/managers/${fixture.lead.id}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId }) });
    const noteBefore = await (await fixture.api(`/api/notes/${missionNoteId}`)).text();

    const ack = jsonOf(await call(lead, 'propose_law', law));
    const governance = await governanceOf(lead);

    expect(governance.pending).toEqual([expect.objectContaining({ request_id: ack.request_id, kind: 'law', text: law.body, incident: law.incident })]);
    expect(governance.resourceGrants).toEqual([]);
    expect(await (await fixture.api(`/api/notes/${missionNoteId}`)).text()).toBe(noteBefore);
  });

  it('says where the laws in force live and returns none', async () => {
    const governance = await governanceOf(lead);

    expect(governance.note).toContain('mission note');
    expect(Object.keys(governance).sort()).toEqual(['denied', 'governanceEvictedDenials', 'history', 'note', 'pending', 'resourceGrants']);
  });

  it('answers the same pending proposal with its id, flagged deduplicated, and lists it once', async () => {
    const first = jsonOf(await call(lead, 'propose_law', law));

    const again = jsonOf(await call(lead, 'propose_law', law));

    expect(again).toMatchObject({ request_id: first.request_id, deduplicated: true });
    expect(first.deduplicated).toBeUndefined();
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it('hides the proposals of a manager from its sibling', async () => {
    await call(lead, 'propose_law', law);

    expect((await governanceOf(siblingLead)).pending).toEqual([]);
  });

  it('refuses a proposal past the cap with governance_queue_full, retry later', async () => {
    for (let index = 0; index < 10; index++) await call(lead, 'propose_law', { ...law, body: `Law ${index}` });

    const result = await call(lead, 'propose_law', { ...law, body: 'One too many' });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/^error governance_queue_full: .*withdraw_proposal.* \(retry: later\)$/);
  });

  it('answers the existing id of a duplicate when the queue is full, without governance_queue_full', async () => {
    const first = jsonOf(await call(lead, 'propose_law', { ...law, body: 'Law 0' }));
    for (let index = 1; index < 10; index++) await call(lead, 'propose_law', { ...law, body: `Law ${index}` });

    const again = await call(lead, 'propose_law', { ...law, body: 'Law 0' });

    expect(isError(again)).toBe(false);
    expect(jsonOf(again)).toMatchObject({ request_id: first.request_id, deduplicated: true });
  });

  it('masks a secret the agent wrote in its incident', async () => {
    await call(lead, 'propose_law', { ...law, incident: 'the agent printed Bearer abcdef1234567890SECRETvalue' });

    expect(JSON.stringify(await governanceOf(lead))).not.toContain('abcdef1234567890SECRETvalue');
  });

  it('masks a secret the agent wrote in the body of its law', async () => {
    await call(lead, 'propose_law', { ...law, body: 'Never paste Bearer abcdef1234567890SECRETvalue anywhere' });

    expect(JSON.stringify(await governanceOf(lead))).not.toContain('abcdef1234567890SECRETvalue');
  });
});

describe('request_resource_access', () => {
  it('answers a table of another project and a missing id with the same words', async () => {
    const foreignTableId = await fixture.createTable(OTHER_PROJECT_ID, 'Foreign');
    const request = (resource_id: string) => call(lead, 'request_resource_access', { resource_type: 'dataStore', resource_id, access: 'read', role: 'reference', incident: 'need it' });

    const foreign = await request(foreignTableId);
    const missing = await request('no-such-table');

    expect(textOf(foreign)).toMatch(/^error store_not_found: /);
    expect(textOf(foreign)).toBe(textOf(missing));
  });

  it.each([
    ['a role past 80 characters', { role: 'r'.repeat(81) }],
    ['a resource id past 500 characters', { resource_id: 'i'.repeat(501) }],
  ])('refuses %s', async (_label, overrides) => {
    const noteId = await fixture.createNote(OWN_PROJECT_ID, 'Runbook');

    const result = await call(lead, 'request_resource_access', { resource_type: 'note', resource_id: noteId, access: 'read', role: 'reference', incident: 'need it', ...overrides });

    expect(textOf(result)).toMatch(/^error invalid_body: /);
    expect((await governanceOf(lead)).pending).toEqual([]);
  });

  it('refuses an append on a table', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');

    const result = await call(lead, 'request_resource_access', { resource_type: 'dataStore', resource_id: tableId, access: 'append', role: 'journal', incident: 'need it' });

    expect(textOf(result)).toMatch(/^error invalid_body: /);
  });

  it('refuses a playbook as not available yet', async () => {
    const result = await call(lead, 'request_resource_access', { resource_type: 'playbook', resource_id: 'pb', access: 'run', role: 'job', incident: 'need it' });

    expect(textOf(result)).toMatch(/^error invalid_body: .*not available/);
  });

  it('files a request on a table of its own project, pending and granting nothing', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');

    const ack = jsonOf(await call(lead, 'request_resource_access', { resource_type: 'dataStore', resource_id: tableId, access: 'readWrite', role: 'work-source', incident: 'need it' }));
    const governance = await governanceOf(lead);

    expect(ack).toMatchObject({ status: 'pending' });
    expect(governance.pending).toEqual([expect.objectContaining({ kind: 'resourceAccess', resourceId: tableId, access: 'readWrite', role: 'work-source' })]);
    expect(governance.resourceGrants).toEqual([]);
  });
});

describe('withdraw_proposal', () => {
  it('takes a pending proposal of its own out of pending and into the history as withdrawn', async () => {
    const { request_id } = jsonOf(await call(lead, 'propose_law', law));

    const result = jsonOf(await call(lead, 'withdraw_proposal', { request_id }));
    const governance = await governanceOf(lead);

    expect(result).toEqual({ request_id, status: 'withdrawn' });
    expect(governance.pending).toEqual([]);
    expect(governance.history).toEqual([expect.objectContaining({ request_id, status: 'withdrawn' })]);
  });

  it('answers proposal_not_found for the proposal of another manager, and leaves it pending', async () => {
    const { request_id } = jsonOf(await call(lead, 'propose_law', law));

    const result = await call(siblingLead, 'withdraw_proposal', { request_id });

    expect(textOf(result)).toMatch(/^error proposal_not_found: .* \(retry: never\)$/);
    expect((await governanceOf(lead)).pending).toHaveLength(1);
  });

  it('answers already_resolved for an approved proposal', async () => {
    const { request_id } = jsonOf(await call(lead, 'propose_law', law));
    fixture.governanceQueue.decide({ proposalId: request_id, decision: 'approve' });

    const result = await call(lead, 'withdraw_proposal', { request_id });

    expect(textOf(result)).toMatch(/^error already_resolved: /);
  });

  it('frees a place at the cap', async () => {
    const first = jsonOf(await call(lead, 'propose_law', { ...law, body: 'Law 0' }));
    for (let index = 1; index < 10; index++) await call(lead, 'propose_law', { ...law, body: `Law ${index}` });

    await call(lead, 'withdraw_proposal', { request_id: first.request_id });

    expect(isError(await call(lead, 'propose_law', { ...law, body: 'One more' }))).toBe(false);
  });
});

describe('what a human answered, read back by the manager', () => {
  it('shows a denial with its reason, an approved access as a grant and an approved law only as history', async () => {
    const tableId = await fixture.createTable(OWN_PROJECT_ID, 'Sales');
    const denied = jsonOf(await call(lead, 'propose_law', law));
    const approvedLaw = jsonOf(await call(lead, 'propose_law', { ...law, body: 'Always run the tests' }));
    const access = jsonOf(await call(lead, 'request_resource_access', { resource_type: 'dataStore', resource_id: tableId, access: 'read', role: 'reference', incident: 'need it' }));

    fixture.governanceQueue.decide({ proposalId: denied.request_id, decision: 'deny', reason: 'too vague' });
    fixture.governanceQueue.decide({ proposalId: approvedLaw.request_id, decision: 'approve' });
    fixture.governanceQueue.decide({ proposalId: access.request_id, decision: 'approve' });
    const governance = await governanceOf(lead);

    expect(governance.denied).toEqual([expect.objectContaining({ request_id: denied.request_id, reason: 'too vague' })]);
    expect(governance.resourceGrants).toEqual([expect.objectContaining({ resourceId: tableId, access: 'read', role: 'reference' })]);
    expect(governance.history.map((entry: { status: string }) => entry.status).sort()).toEqual(['approved', 'approved']);
    expect(governance.pending).toEqual([]);
  });
});

describe('the governance queue across a daemon restart', () => {
  const directories = createTempDirTracker();
  afterEach(() => { directories.removeAll(); });

  it('keeps the pending proposals', async () => {
    const home = directories.make('governance-restart-');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
    const options = { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } };
    const firstRun = await startDaemon(config, options);
    const created = await fetch(`${firstRun.server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ directory: home, name: 'Lead', harness: 'fake', emoji: '🤖', manager: { childrenCap: 1, mission: 'x', pulseSeconds: 3600 } }) });
    const { id } = await created.json() as { id: string };
    firstRun.governanceQueue.proposeLaw({ managerId: id, text: 'Survive the restart', incident: 'daemon restart' });
    await firstRun.close();

    const secondRun = await startDaemon(config, options);
    const pendingTexts = secondRun.governanceQueue.viewOf(id).pending.map((proposal) => proposal.payload);
    await secondRun.close();

    expect(pendingTexts).toEqual([{ text: 'Survive the restart' }]);
  });
});
