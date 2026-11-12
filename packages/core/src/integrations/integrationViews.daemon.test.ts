import { randomUUID } from 'node:crypto';
import { OPERATOR_NONCE_HEADER } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OTHER_PROJECT_ID, OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createFakeTauriParent, type FakeTauriParent } from '../secrets/fakeTauriParent.testkit.js';
import { createInMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { startFakeHttpServer, type FakeHttpServer } from './fakeHttpServer.testkit.js';
import { shippedIntegrationProviders, type IntegrationProvider } from './integrationProviders.js';
import { reviewDigestOf } from './integrationViewConfig.js';
import type { ResolvedAddress } from './providerReader.js';

const START_OF_TEST_TIME = Date.parse('2026-11-09T10:00:00.000Z');
const MINUTE = 60_000;
const POLL_INTERVAL = 5 * MINUTE;
const HOST = 'acme.atlassian.net';
const HUMAN_PROOF_HEADER = 'x-human-proof';
const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const DEFAULT_QUERY = 'project = CCM AND resolution = Unresolved ORDER BY updated DESC';
const PROPOSED_JQL = 'project = CCM and status in (Open, "In Progress") order by updated desc';
const CANONICAL_JQL = 'project = "CCM" AND status IN ("Open", "In Progress") ORDER BY updated DESC';

const makeCanary = () => ['canary', randomUUID()].join('-');
const issueOf = (key: string) => ({ id: key, key, fields: { summary: `Summary of ${key}`, status: { name: 'Open' }, updated: '2026-11-09T09:00:00.000Z' } });
const searchBody = (...issues: ReturnType<typeof issueOf>[]) => JSON.stringify({ issues });

let fixture: GovernanceFixture;
let jira: FakeHttpServer;
let parent: FakeTauriParent;
let now: number;

beforeEach(async () => {
  jira = await startFakeHttpServer();
  parent = createFakeTauriParent();
  now = START_OF_TEST_TIME;
  jira.answerWith({ status: 200, body: searchBody(issueOf('CCM-1')) });
  const shipped = shippedIntegrationProviders().find((provider) => provider.id === 'jira_cloud')!;
  const provider: IntegrationProvider = { ...shipped, scheme: 'http', port: jira.port, isAddressAllowed: () => true };
  fixture = await startGovernanceFixture({
    secrets: { store: createInMemorySecretStore(), parent: parent.link },
    integrations: { providers: [provider], clock: () => now, monotonicClock: () => now, resolveAddress: async () => LOOPBACK, probe: async () => 'ok' },
  });
});
afterEach(async () => {
  await fixture.close();
  await jira.stop();
});

const rest = async (method: string, path: string, { body, headers }: { body?: unknown; headers?: Record<string, string> } = {}) => {
  const response = await fixture.api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(headers !== undefined && { headers }) });
  const text = await response.text();
  return { status: response.status, text, json: text.length > 0 ? (JSON.parse(text) as Record<string, any>) : undefined };
};
const poll = () => fixture.daemon.integrationPoller.pollOnce();
const advance = (milliseconds: number) => { now += milliseconds; };

const connectedIntegration = async (value = makeCanary()) => {
  const connection = (await rest('POST', '/api/integration-connections', { body: { name: 'Jira', provider: 'jira_cloud', allowedHosts: [HOST] } })).json as { id: string };
  const integration = (await rest('POST', '/api/integrations', { body: { projectId: OWN_PROJECT_ID, connectionId: connection.id, name: 'Backlog', resource: 'CCM' } })).json as { id: string };
  const nonce = parent.mintOperatorNonce({ action: 'set', scope: { kind: 'connection', id: connection.id }, name: 'TOKEN' });
  await fixture.api(`/api/secrets/connection/${connection.id}/TOKEN`, { method: 'PUT', headers: { [OPERATOR_NONCE_HEADER]: nonce }, body: JSON.stringify({ value }) });
  return { integration, value };
};

const viewPath = (integrationId: string, projectId = OWN_PROJECT_ID) => `/api/integrations/${integrationId}/view-config?projectId=${projectId}`;
const propose = (integrationId: string, body: Record<string, unknown> = {}, projectId = OWN_PROJECT_ID) =>
  rest('PUT', viewPath(integrationId, projectId), { body: { jql: PROPOSED_JQL, fields: ['summary', 'status'], ...body } });
const approvalNonceFor = (integrationId: string) => parent.mintOperatorNonce({ action: 'integration.approve_view', scope: { kind: 'integration', id: integrationId }, name: integrationId });
const approve = (integrationId: string, { approvedRev = 1, proof, projectId = OWN_PROJECT_ID }: { approvedRev?: number; proof?: string; projectId?: string } = {}) =>
  rest('POST', `/api/integrations/${integrationId}/view-config/approve?projectId=${projectId}`, { body: { approvedRev }, headers: proof === undefined ? {} : { [HUMAN_PROOF_HEADER]: proof } });
const viewOf = async (integrationId: string) => (await rest('GET', viewPath(integrationId))).json as Record<string, any>;
const activeJqlOf = async (integrationId: string) => (await viewOf(integrationId)).active?.jql as string | undefined;
const proposalJqlOf = async (integrationId: string) => (await viewOf(integrationId)).proposal?.jql as string | undefined;
const queryOfRequest = (index: number) => new URL(jira.seen[index]!.path, 'http://x').searchParams;
const mcpBearerOfTheLead = () => (fixture.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(fixture.lead.id) as { mcp_token: string }).mcp_token;
const withTheMcpBearer = (path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) =>
  fetch(`${fixture.daemon.server.url}${path}`, {
    method: init.method, ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpBearerOfTheLead()}`, ...init.headers },
  });

describe('proposing the view configuration of an integration', () => {
  it('stores the proposal in its canonical form, as a proposal at revision 1 with nothing active', async () => {
    const { integration } = await connectedIntegration();

    const proposed = await propose(integration.id);

    expect(proposed.status).toBe(200);
    expect(proposed.json).toMatchObject({ integrationId: integration.id, contentRev: 1, proposal: { jql: CANONICAL_JQL, fields: ['summary', 'status'], contentRev: 1 } });
    expect(proposed.json!.active).toBeUndefined();
  });

  it('refuses a query whose canonical form exceeds the bound, with its code, and stores nothing', async () => {
    const { integration } = await connectedIntegration();
    const eightClausesOfTwentyLabels = Array(8).fill('labels in (a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t)').join(' and ');

    const refused = await propose(integration.id, { jql: eightClausesOfTwentyLabels });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: 'integration_view_jql_refused' });
    expect((await rest('GET', viewPath(integration.id))).status).toBe(404);
  });

  it('refuses a query outside the allow list and stores nothing', async () => {
    const { integration } = await connectedIntegration();

    const refused = await propose(integration.id, { jql: 'project = CCM OR assignee = membersOf("admins")' });

    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: 'integration_view_jql_refused' });
    const stored = await rest('GET', viewPath(integration.id));
    expect(stored.status).toBe(404);
    expect(stored.json).toMatchObject({ error: 'integration_view_config_not_found' });
  });

  it('refuses a field outside the list, and a body with a field it does not know', async () => {
    const { integration } = await connectedIntegration();

    const unknownField = await propose(integration.id, { fields: ['summary', 'description'] });
    const unknownProperty = await propose(integration.id, { token: 'x' });

    expect([unknownField.status, unknownProperty.status]).toEqual([400, 400]);
  });

  it('refuses a write on an old revision', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);

    const stale = await propose(integration.id, { expectedRev: 7 });

    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'stale_revision' });
  });

  it('refuses an integration of another project, as one that does not exist', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);

    const proposedFromElsewhere = await propose(integration.id, {}, OTHER_PROJECT_ID);
    const readFromElsewhere = await rest('GET', viewPath(integration.id, OTHER_PROJECT_ID));
    const approvedFromElsewhere = await approve(integration.id, { proof: approvalNonceFor(integration.id), projectId: OTHER_PROJECT_ID });

    expect([proposedFromElsewhere.status, readFromElsewhere.status, approvedFromElsewhere.status]).toEqual([404, 404, 404]);
    expect(proposedFromElsewhere.json).toMatchObject({ error: 'integration_not_found' });
    expect(await activeJqlOf(integration.id)).toBeUndefined();
  });
});

const insertRowByHand = (integrationId: string, row: { pendingJql?: string; activeJql?: string; activeDigest?: string; contentRev?: number; fieldsJson?: string }) =>
  fixture.daemon.db.prepare(`INSERT OR REPLACE INTO integration_view_configs
    (profile_id, content_rev, pending_jql, pending_fields_json, active_jql, active_fields_json, approved_rev, approved_digest, approved_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'n')`)
    .run(
      integrationId, row.contentRev ?? 1,
      row.pendingJql ?? null, row.pendingJql === undefined ? null : '["summary"]',
      row.activeJql ?? null, row.activeJql === undefined ? null : (row.fieldsJson ?? '["summary"]'),
      row.activeJql === undefined ? null : 1, row.activeDigest ?? null, row.activeJql === undefined ? null : 'n',
    );

describe('a pending proposal', () => {
  it('has no effect on the polling: the default query still runs', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);

    await poll();
    advance(POLL_INTERVAL);
    await poll();

    expect(jira.seen).toHaveLength(2);
    expect([queryOfRequest(0).get('jql'), queryOfRequest(1).get('jql')]).toEqual([DEFAULT_QUERY, DEFAULT_QUERY]);
  });

  it('never changes the query used, even a proposal written straight into the database: default query, then the active one', async () => {
    const { integration } = await connectedIntegration();
    insertRowByHand(integration.id, { pendingJql: 'project = "HACKED"' });
    await poll();
    await propose(integration.id);
    await approve(integration.id, { approvedRev: 2, proof: approvalNonceFor(integration.id) });
    advance(POLL_INTERVAL);
    await poll();
    fixture.daemon.db.prepare('UPDATE integration_view_configs SET pending_jql = ?, pending_fields_json = ?, content_rev = content_rev + 1 WHERE profile_id = ?').run('project = "HACKED"', '["summary"]', integration.id);
    advance(POLL_INTERVAL);
    await poll();

    expect(jira.seen.map((request) => new URL(request.path, 'http://x').searchParams.get('jql'))).toEqual([DEFAULT_QUERY, CANONICAL_JQL, CANONICAL_JQL]);
  });
});

describe('an active configuration that no longer matches what a human approved', () => {
  it.each([
    ['a digest nobody computed', { activeJql: 'project = "CCM"', activeDigest: 'a digest nobody computed' }],
    ['a text edited after its approval', { activeJql: 'project = "ANYTHING"', activeDigest: reviewDigestOf({ jql: 'project = "CCM"', fields: ['summary'] }) }],
    ['a text the daemon would not accept, with a digest that matches', { activeJql: 'project = CCM OR 1=1', activeDigest: reviewDigestOf({ jql: 'project = CCM OR 1=1', fields: ['summary'] }) }],
    ['fields that are not valid JSON', { activeJql: 'project = "CCM"', activeDigest: reviewDigestOf({ jql: 'project = "CCM"', fields: ['summary'] }), fieldsJson: '{not json' }],
  ])('runs nothing, not even the default query, with %s, and says so in its status', async (_name, row) => {
    const { integration } = await connectedIntegration();
    insertRowByHand(integration.id, row);

    await poll();
    advance(POLL_INTERVAL);
    await poll();

    expect(jira.seen).toHaveLength(0);
    expect((await viewOf(integration.id)).active).toMatchObject({ status: 'withheld' });
  });

  it('is reported as running while the content still has the approved digest', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    await approve(integration.id, { proof: approvalNonceFor(integration.id) });

    expect((await viewOf(integration.id)).active).toMatchObject({ status: 'running', jql: CANONICAL_JQL, approvedRev: 1 });
  });
});

describe('approving the view configuration of an integration', () => {
  it('is refused without a proof of a human gesture, and the configuration stays pending', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);

    const withoutProof = await approve(integration.id);
    const withAProofNobodyMinted = await approve(integration.id, { proof: 'a-proof-nobody-minted-0123456789' });

    expect([withoutProof.status, withAProofNobodyMinted.status]).toEqual([401, 401]);
    expect(withoutProof.json).toMatchObject({ error: 'human_proof_required' });
    expect(await activeJqlOf(integration.id)).toBeUndefined();
    await poll();
    expect(queryOfRequest(0).get('jql')).toBe(DEFAULT_QUERY);
  });

  it('is refused when there is no proposal to approve, with its own code', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    await approve(integration.id, { proof: approvalNonceFor(integration.id) });

    const nothingToApprove = await approve(integration.id, { approvedRev: 1, proof: approvalNonceFor(integration.id) });

    expect(nothingToApprove.status).toBe(404);
    expect(nothingToApprove.json).toMatchObject({ error: 'integration_view_proposal_not_found' });
  });

  it('refuses the admin token alone, with the operator nonce header of a secret write in place of the proof', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const nonceOfASecretWrite = parent.mintOperatorNonce({ action: 'set', scope: { kind: 'integration', id: integration.id }, name: integration.id });

    const response = await approve(integration.id, { proof: nonceOfASecretWrite });

    expect(response.status).toBe(401);
    expect(await activeJqlOf(integration.id)).toBeUndefined();
  });

  it('refuses a nonce minted to arm a trigger of the same id', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const nonceToArm = parent.mintOperatorNonce({ action: 'trigger.arm', scope: { kind: 'trigger', id: integration.id }, name: integration.id });

    const response = await approve(integration.id, { proof: nonceToArm });

    expect(response.status).toBe(401);
    expect(await activeJqlOf(integration.id)).toBeUndefined();
  });

  it('refuses a nonce minted for another integration, and spends it', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const otherConnection = (await rest('POST', '/api/integration-connections', { body: { name: 'Jira bis', provider: 'jira_cloud', allowedHosts: [HOST] } })).json as { id: string };
    const other = (await rest('POST', '/api/integrations', { body: { projectId: OWN_PROJECT_ID, connectionId: otherConnection.id, name: 'Other', resource: 'ABC' } })).json as { id: string };
    await propose(other.id);
    const nonceOfOther = approvalNonceFor(other.id);

    const onTheWrongIntegration = await approve(integration.id, { proof: nonceOfOther });
    const onItsOwnIntegrationAfterwards = await approve(other.id, { proof: nonceOfOther });

    expect([onTheWrongIntegration.status, onItsOwnIntegrationAfterwards.status]).toEqual([401, 401]);
    expect([await activeJqlOf(integration.id), await activeJqlOf(other.id)]).toEqual([undefined, undefined]);
  });

  it('refuses a nonce that was already used', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const nonce = approvalNonceFor(integration.id);
    await approve(integration.id, { proof: nonce });
    await propose(integration.id, { fields: ['summary'] });

    const replayed = await approve(integration.id, { approvedRev: 2, proof: nonce });

    expect(replayed.status).toBe(401);
    expect(await activeJqlOf(integration.id)).toBe(CANONICAL_JQL);
    expect(await proposalJqlOf(integration.id)).toBeDefined();
  });

  it('refuses a revision other than the one the human reviewed', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    await propose(integration.id, { fields: ['summary'] });

    const reviewedTheFirst = await approve(integration.id, { approvedRev: 1, proof: approvalNonceFor(integration.id) });

    expect(reviewedTheFirst.status).toBe(409);
    expect(await activeJqlOf(integration.id)).toBeUndefined();
  });

  it('promotes the reviewed proposal to the active configuration, atomically: the proposal slot is emptied', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id, { fields: ['summary', 'status'] });

    const approved = await approve(integration.id, { proof: approvalNonceFor(integration.id) });

    expect(approved.json).toMatchObject({ active: { jql: CANONICAL_JQL, fields: ['summary', 'status'], approvedRev: 1, status: 'running', approvedAt: new Date(START_OF_TEST_TIME).toISOString() } });
    expect(approved.json!.proposal).toBeUndefined();
  });

  it('approves the proposal with the nonce minted for this integration, then runs exactly that query and those fields', async () => {
    const { integration, value } = await connectedIntegration();
    await propose(integration.id, { fields: ['summary', 'status', 'updated'] });

    const approved = await approve(integration.id, { proof: approvalNonceFor(integration.id) });
    await poll();

    expect(approved.status).toBe(200);
    expect(approved.status).toBe(200);
    expect(jira.seen).toHaveLength(1);
    expect(jira.seen[0]!.method).toBe('GET');
    expect(queryOfRequest(0).get('jql')).toBe(CANONICAL_JQL);
    expect(queryOfRequest(0).get('fields')).toBe('summary,status,updated');
    const items = await rest('GET', `/api/integrations/${integration.id}/items?projectId=${OWN_PROJECT_ID}`);
    expect(items.json).toMatchObject({ items: [{ key: 'CCM-1' }] });
    expect(approved.text + items.text).not.toContain(value);
  });

  it('asks the approved query fresh: the ETag of the default query is not sent back', async () => {
    const { integration } = await connectedIntegration();
    jira.answerWith({ status: 200, headers: { etag: '"default-query"' }, body: searchBody(issueOf('CCM-1')) });
    await poll();
    await propose(integration.id);

    await approve(integration.id, { proof: approvalNonceFor(integration.id) });
    await poll();

    expect(jira.seen).toHaveLength(2);
    expect(queryOfRequest(0).get('jql')).toBe(DEFAULT_QUERY);
    expect(jira.seen[0]!.headers['if-none-match']).toBeUndefined();
    expect(jira.seen[1]!.headers['if-none-match']).toBeUndefined();
    expect(queryOfRequest(1).get('jql')).toBe(CANONICAL_JQL);
  });
});

describe('changing an approved view configuration', () => {
  const approvedIntegration = async () => {
    const connected = await connectedIntegration();
    await propose(connected.integration.id);
    await approve(connected.integration.id, { proof: approvalNonceFor(connected.integration.id) });
    await poll();
    return connected;
  };

  it.each([
    ['the query', { jql: 'project = CCM AND status = Open' }],
    ['the displayed fields only', { fields: ['summary'] }],
  ])('keeps the active configuration running when a proposal changes %s', async (_name, change) => {
    const { integration } = await approvedIntegration();

    const edited = await propose(integration.id, change);
    advance(POLL_INTERVAL);
    await poll();

    expect(edited.json).toMatchObject({ contentRev: 2, proposal: { contentRev: 2 }, active: { jql: CANONICAL_JQL, status: 'running', approvedRev: 1 } });
    expect(jira.seen).toHaveLength(2);
    expect(queryOfRequest(1).get('jql')).toBe(CANONICAL_JQL);
    expect(queryOfRequest(1).get('fields')).toBe('summary,status');
  });

  it('keeps the active configuration and the polling untouched through 100 successive proposals, so a proposer cannot freeze the profile', async () => {
    const { integration } = await approvedIntegration();
    const activeBefore = (await viewOf(integration.id)).active;

    for (let proposal = 0; proposal < 100; proposal += 1) {
      await propose(integration.id, { jql: `project = CCM AND status = Open${proposal % 2 === 0 ? '' : ' AND labels = x'}` });
      advance(POLL_INTERVAL);
      await poll();
    }

    expect((await viewOf(integration.id)).active).toEqual(activeBefore);
    expect((await viewOf(integration.id)).contentRev).toBe(101);
    expect(jira.seen).toHaveLength(101);
    const queriesRun = new Set(jira.seen.map((request) => new URL(request.path, 'http://x').searchParams.get('jql')));
    expect([...queriesRun]).toEqual([CANONICAL_JQL]);
  });

  it('erases nothing when the proposal is identical to the active configuration', async () => {
    const { integration } = await approvedIntegration();
    const activeBefore = (await viewOf(integration.id)).active;

    const rewritten = await propose(integration.id);

    expect(rewritten.json).toMatchObject({ contentRev: 2, proposal: { jql: CANONICAL_JQL } });
    expect(rewritten.json!.active).toEqual(activeBefore);
  });

  it('runs the new content only after a new approval of the new revision, which replaces the active configuration', async () => {
    const { integration } = await approvedIntegration();
    await propose(integration.id, { jql: 'project = CCM AND status = Open' });

    const approvedAgain = await approve(integration.id, { approvedRev: 2, proof: approvalNonceFor(integration.id) });
    await poll();

    expect(approvedAgain.json).toMatchObject({ contentRev: 2, active: { jql: 'project = "CCM" AND status = "Open"', approvedRev: 2, status: 'running' } });
    expect(approvedAgain.json!.proposal).toBeUndefined();
    expect(queryOfRequest(jira.seen.length - 1).get('jql')).toBe('project = "CCM" AND status = "Open"');
  });
});

describe('the reach of an agent over the view configurations', () => {
  it('offers no tool that writes or approves a view configuration: I2b-1 is REST only', async () => {
    const lead = await fixture.connect(fixture.lead.id);

    const names = (await lead.listTools()).tools.map((tool) => tool.name);

    expect(names.filter((name) => /view_config|integration.*approve|approve.*integration/.test(name))).toEqual([]);
  });

  it('has no route under /mcp for the view configuration', async () => {
    const { integration } = await connectedIntegration();

    const response = await fixture.api(`/mcp/api/integrations/${integration.id}/view-config/approve?projectId=${OWN_PROJECT_ID}`, { method: 'POST', body: JSON.stringify({ approvedRev: 1 }) });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await activeJqlOf(integration.id)).toBeUndefined();
  });

  it('refuses the MCP bearer of a session on the real /api route of the proposal, of the approval and of the read, and leaves the state unchanged', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const proposalBefore = await proposalJqlOf(integration.id);
    const proofForThisIntegration = approvalNonceFor(integration.id);

    const read = await withTheMcpBearer(viewPath(integration.id), { method: 'GET' });
    const proposed = await withTheMcpBearer(viewPath(integration.id), { method: 'PUT', body: { jql: 'project = CCM AND status = Open', fields: ['summary'] } });
    const approved = await withTheMcpBearer(`/api/integrations/${integration.id}/view-config/approve?projectId=${OWN_PROJECT_ID}`, { method: 'POST', body: { approvedRev: 1 }, headers: { [HUMAN_PROOF_HEADER]: proofForThisIntegration } });

    expect([read.status, proposed.status, approved.status]).toEqual([401, 401, 401]);
    expect(await activeJqlOf(integration.id)).toBeUndefined();
    expect(await proposalJqlOf(integration.id)).toBe(proposalBefore);
    expect((await viewOf(integration.id)).contentRev).toBe(1);
  });

  it('still accepts the admin token on that same route with the same proof, so the refusal comes from the bearer and not from the request', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);

    const approved = await approve(integration.id, { proof: approvalNonceFor(integration.id) });

    expect(approved.status).toBe(200);
  });
});
