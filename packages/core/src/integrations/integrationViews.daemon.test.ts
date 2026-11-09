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
const stateOf = async (integrationId: string) => (await rest('GET', viewPath(integrationId))).json!.state as string;
const queryOfRequest = (index: number) => new URL(jira.seen[index]!.path, 'http://x').searchParams;

describe('proposing the view configuration of an integration', () => {
  it('stores the proposal in its canonical form, pending, at revision 1', async () => {
    const { integration } = await connectedIntegration();

    const proposed = await propose(integration.id);

    expect(proposed.status).toBe(200);
    expect(proposed.json).toMatchObject({ integrationId: integration.id, jql: CANONICAL_JQL, fields: ['summary', 'status'], contentRev: 1, state: 'pending' });
    expect(proposed.json!.approvedAt).toBeUndefined();
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
    expect(await stateOf(integration.id)).toBe('pending');
  });
});

describe('a pending view configuration', () => {
  it('has no effect on the polling: nothing is asked of the provider', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);

    await poll();
    advance(POLL_INTERVAL);
    await poll();

    expect(jira.seen).toHaveLength(0);
  });

  it('is not run when its row is read straight from the database: pending, with a wrong digest, or edited after its approval', async () => {
    const { integration } = await connectedIntegration();
    const insert = fixture.daemon.db.prepare("INSERT OR REPLACE INTO integration_view_configs (profile_id, jql, fields_json, content_rev, approved_rev, approved_digest, approved_at, updated_at) VALUES (?, ?, '[\"summary\"]', 1, ?, ?, ?, 'n')");

    insert.run(integration.id, 'project = "CCM"', null, null, null);
    await poll();
    advance(POLL_INTERVAL);
    insert.run(integration.id, 'project = "CCM"', 1, 'a digest nobody computed', 'n');
    await poll();
    advance(POLL_INTERVAL);
    await propose(integration.id);
    await approve(integration.id, { approvedRev: 2, proof: approvalNonceFor(integration.id) });
    fixture.daemon.db.prepare('UPDATE integration_view_configs SET jql = ? WHERE profile_id = ?').run('project = "ANYTHING"', integration.id);
    advance(POLL_INTERVAL);
    await poll();

    expect(jira.seen).toHaveLength(0);
  });

  it('is not run when it was approved and its text is no longer one the daemon accepts, even with a digest that matches', async () => {
    const { integration } = await connectedIntegration();
    const rawJql = 'project = CCM OR 1=1';
    const digestOfRaw = reviewDigestOf({ jql: rawJql, fields: ['summary'] });
    fixture.daemon.db.prepare("INSERT INTO integration_view_configs (profile_id, jql, fields_json, content_rev, approved_rev, approved_digest, approved_at, updated_at) VALUES (?, ?, '[\"summary\"]', 1, 1, ?, 'n', 'n')").run(integration.id, rawJql, digestOfRaw);

    await poll();

    expect(jira.seen).toHaveLength(0);
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
    expect(await stateOf(integration.id)).toBe('pending');
    await poll();
    expect(jira.seen).toHaveLength(0);
  });

  it('refuses the admin token alone, with the operator nonce header of a secret write in place of the proof', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const nonceOfASecretWrite = parent.mintOperatorNonce({ action: 'set', scope: { kind: 'integration', id: integration.id }, name: integration.id });

    const response = await approve(integration.id, { proof: nonceOfASecretWrite });

    expect(response.status).toBe(401);
    expect(await stateOf(integration.id)).toBe('pending');
  });

  it('refuses a nonce minted to arm a trigger of the same id', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const nonceToArm = parent.mintOperatorNonce({ action: 'trigger.arm', scope: { kind: 'trigger', id: integration.id }, name: integration.id });

    const response = await approve(integration.id, { proof: nonceToArm });

    expect(response.status).toBe(401);
    expect(await stateOf(integration.id)).toBe('pending');
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
    expect([await stateOf(integration.id), await stateOf(other.id)]).toEqual(['pending', 'pending']);
  });

  it('refuses a nonce that was already used', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    const nonce = approvalNonceFor(integration.id);
    await approve(integration.id, { proof: nonce });
    await propose(integration.id, { fields: ['summary'] });

    const replayed = await approve(integration.id, { approvedRev: 2, proof: nonce });

    expect(replayed.status).toBe(401);
    expect(await stateOf(integration.id)).toBe('pending');
  });

  it('refuses a revision other than the one the human reviewed', async () => {
    const { integration } = await connectedIntegration();
    await propose(integration.id);
    await propose(integration.id, { fields: ['summary'] });

    const reviewedTheFirst = await approve(integration.id, { approvedRev: 1, proof: approvalNonceFor(integration.id) });

    expect(reviewedTheFirst.status).toBe(409);
    expect(await stateOf(integration.id)).toBe('pending');
  });

  it('approves the proposal with the nonce minted for this integration, then runs exactly that query and those fields', async () => {
    const { integration, value } = await connectedIntegration();
    await propose(integration.id, { fields: ['summary', 'status', 'updated'] });

    const approved = await approve(integration.id, { proof: approvalNonceFor(integration.id) });
    await poll();

    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ state: 'approved', contentRev: 1, approvedAt: new Date(START_OF_TEST_TIME).toISOString() });
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
  ])('sends it back to pending when %s changes, and the daemon stops running it', async (_name, change) => {
    const { integration } = await approvedIntegration();
    const requestsBefore = jira.seen.length;

    const edited = await propose(integration.id, change);
    advance(POLL_INTERVAL);
    await poll();

    expect(edited.json).toMatchObject({ state: 'pending', contentRev: 2 });
    expect(edited.json!.approvedAt).toBeUndefined();
    expect(await stateOf(integration.id)).toBe('pending');
    expect(jira.seen).toHaveLength(requestsBefore);
  });

  it('sends it back to pending even when the same content is written again', async () => {
    const { integration } = await approvedIntegration();

    const rewritten = await propose(integration.id);

    expect(rewritten.json).toMatchObject({ state: 'pending', contentRev: 2 });
  });

  it('runs the new content only after a new approval of the new revision', async () => {
    const { integration } = await approvedIntegration();
    await propose(integration.id, { jql: 'project = CCM AND status = Open' });

    const approvedAgain = await approve(integration.id, { approvedRev: 2, proof: approvalNonceFor(integration.id) });
    await poll();

    expect(approvedAgain.json).toMatchObject({ state: 'approved', contentRev: 2 });
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
    expect(await stateOfIfAny(integration.id)).not.toBe('approved');
  });
});

const stateOfIfAny = async (integrationId: string) => (await rest('GET', viewPath(integrationId))).json?.state as string | undefined;
