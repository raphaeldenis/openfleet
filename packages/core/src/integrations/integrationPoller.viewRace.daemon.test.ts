import { randomUUID } from 'node:crypto';
import { OPERATOR_NONCE_HEADER } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createFakeTauriParent, type FakeTauriParent } from '../secrets/fakeTauriParent.testkit.js';
import { createInMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { shippedIntegrationProviders, type IntegrationProvider } from './integrationProviders.js';
import { pollQueryOf } from './integrationViewConfig.js';
import { deferred, settle, until } from './manualTimers.testkit.js';
import type { ProviderAnswer, ProviderGet, ProviderReader, ResolvedAddress } from './providerReader.js';

const START_OF_TEST_TIME = Date.parse('2026-11-09T10:00:00.000Z');
const POLL_INTERVAL = 5 * 60_000;
const HOST = 'acme.atlassian.net';
const HUMAN_PROOF_HEADER = 'x-human-proof';
const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const DEFAULT_QUERY = 'project = CCM AND resolution = Unresolved ORDER BY updated DESC';
const OLD_JQL = 'project = CCM AND status = Open';
const NEW_JQL = 'project = CCM AND status = Closed';
const CANONICAL_OLD_JQL = 'project = "CCM" AND status = "Open"';
const CANONICAL_NEW_JQL = 'project = "CCM" AND status = "Closed"';
const OLD_ETAG = '"etag-of-the-old-query"';

const issueOf = (key: string) => ({ id: key, key, fields: { summary: `Summary of ${key}`, status: { name: 'Open' }, updated: '2026-11-09T09:00:00.000Z' } });
const okAnswer = (key: string, etag?: string): ProviderAnswer => ({ kind: 'ok', body: { issues: [issueOf(key)] }, ...(etag !== undefined && { etag }) });

let fixture: GovernanceFixture;
let parent: FakeTauriParent;
let now: number;
let credentialReadsStarted: number;
let credentialGate: ReturnType<typeof deferred<void>> | undefined;
let readerCalls: { get: ProviderGet; answer: ReturnType<typeof deferred<ProviderAnswer>> }[];

/** A reader that never answers by itself: the test decides when, and with what, each read ends. */
const handHeldReader: ProviderReader = (get) => {
  const answer = deferred<ProviderAnswer>();
  readerCalls.push({ get, answer });
  return answer.promise;
};

const jqlOfRead = (index: number) => new URL(readerCalls[index]!.get.path, 'http://x').searchParams.get('jql');
const fieldsOfRead = (index: number) => new URL(readerCalls[index]!.get.path, 'http://x').searchParams.get('fields');

beforeEach(async () => {
  parent = createFakeTauriParent();
  now = START_OF_TEST_TIME;
  credentialReadsStarted = 0;
  credentialGate = undefined;
  readerCalls = [];
  const store = createInMemorySecretStore();
  const gatedStore: typeof store = { ...store, read: async (scope, name) => { credentialReadsStarted++; await credentialGate?.promise; return store.read(scope, name); } };
  const shipped = shippedIntegrationProviders().find((provider) => provider.id === 'jira_cloud')!;
  const provider: IntegrationProvider = { ...shipped, scheme: 'http', port: 1, isAddressAllowed: () => true };
  fixture = await startGovernanceFixture({
    secrets: { store: gatedStore, parent: parent.link },
    integrations: { providers: [provider], clock: () => now, monotonicClock: () => now, resolveAddress: async () => LOOPBACK, probe: async () => 'ok', reader: handHeldReader },
  });
});
afterEach(async () => {
  credentialGate?.resolve();
  for (const call of readerCalls) call.answer.resolve({ kind: 'unreachable' });
  await fixture.close();
});

const rest = async (method: string, path: string, { body, headers }: { body?: unknown; headers?: Record<string, string> } = {}) => {
  const response = await fixture.api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(headers !== undefined && { headers }) });
  const text = await response.text();
  return { status: response.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, any>) : undefined };
};
const poll = () => fixture.daemon.integrationPoller.pollOnce();

const connectedIntegration = async () => {
  const connection = (await rest('POST', '/api/integration-connections', { body: { name: 'Jira', provider: 'jira_cloud', allowedHosts: [HOST] } })).json as { id: string };
  const integration = (await rest('POST', '/api/integrations', { body: { projectId: OWN_PROJECT_ID, connectionId: connection.id, name: 'Backlog', resource: 'CCM' } })).json as { id: string };
  const nonce = parent.mintOperatorNonce({ action: 'set', scope: { kind: 'connection', id: connection.id }, name: 'TOKEN' });
  await fixture.api(`/api/secrets/connection/${connection.id}/TOKEN`, { method: 'PUT', headers: { [OPERATOR_NONCE_HEADER]: nonce }, body: JSON.stringify({ value: ['canary', randomUUID()].join('-') }) });
  return integration;
};

const viewPath = (integrationId: string) => `/api/integrations/${integrationId}/view-config?projectId=${OWN_PROJECT_ID}`;
const humanApproves = async (integrationId: string, { jql, fields = ['summary'] }: { jql: string; fields?: string[] }) => {
  const proposed = await rest('PUT', viewPath(integrationId), { body: { jql, fields } });
  const proof = parent.mintOperatorNonce({ action: 'integration.approve_view', scope: { kind: 'integration', id: integrationId }, name: integrationId });
  const approved = await rest('POST', `/api/integrations/${integrationId}/view-config/approve?projectId=${OWN_PROJECT_ID}`, { body: { approvedRev: proposed.json!.contentRev }, headers: { [HUMAN_PROOF_HEADER]: proof } });
  expect(approved.status).toBe(200);
};
const pollStateOf = (integrationId: string) => fixture.db.prepare('SELECT etag, next_poll_at, last_polled_at, consecutive_failures FROM integration_poll_state WHERE profile_id = ?').get(integrationId) as
  { etag: string | null; next_poll_at: string; last_polled_at: string; consecutive_failures: number } | undefined;
const itemKeysOf = (integrationId: string) => (fixture.db.prepare('SELECT external_id FROM integration_view_items WHERE profile_id = ? ORDER BY external_id').all(integrationId) as { external_id: string }[]).map((row) => row.external_id);

const startPassWhileTheCredentialIsAwaited = async () => {
  credentialGate = deferred<void>();
  const readsBefore = credentialReadsStarted;
  const pass = poll();
  await until(() => credentialReadsStarted > readsBefore);
  return { pass };
};
/** Lets the credential through and lets the pass run as far as it goes without a provider answer. */
const releaseTheCredential = async () => {
  credentialGate!.resolve();
  credentialGate = undefined;
  await settle(20);
};
const answerEveryReadAndFinish = async (pass: Promise<void>) => {
  for (const call of readerCalls) call.answer.resolve({ kind: 'unreachable' });
  await pass;
};

describe('a pass that waits for the credential of an integration', () => {
  it('sends no request when the active configuration is edited in the database during the wait', async () => {
    const integration = await connectedIntegration();
    await humanApproves(integration.id, { jql: OLD_JQL });
    const { pass } = await startPassWhileTheCredentialIsAwaited();

    fixture.db.prepare('UPDATE integration_view_configs SET active_jql = ? WHERE profile_id = ?').run('project = "ANYTHING"', integration.id);
    await releaseTheCredential();

    expect(readerCalls).toHaveLength(0);
    await answerEveryReadAndFinish(pass);
  });

  it('sends the old query to nobody when a new configuration is approved during the wait: the new query goes out on the next pass', async () => {
    const integration = await connectedIntegration();
    await humanApproves(integration.id, { jql: OLD_JQL });
    const { pass } = await startPassWhileTheCredentialIsAwaited();

    await humanApproves(integration.id, { jql: NEW_JQL });
    await releaseTheCredential();

    expect(readerCalls).toHaveLength(0);
    await answerEveryReadAndFinish(pass);
    const nextPass = poll();
    await settle(20);
    expect(readerCalls).toHaveLength(1);
    expect(jqlOfRead(0)).toBe(CANONICAL_NEW_JQL);
    readerCalls[0]!.answer.resolve(okAnswer('NEW-1'));
    await nextPass;
  });

  it('does not send the default query when a first configuration is approved during the wait', async () => {
    const integration = await connectedIntegration();
    const { pass } = await startPassWhileTheCredentialIsAwaited();

    await humanApproves(integration.id, { jql: NEW_JQL });
    await releaseTheCredential();

    expect(readerCalls).toHaveLength(0);
    await answerEveryReadAndFinish(pass);
  });

  it('still sends the default query when a proposal is written during the wait: a proposal changes nothing', async () => {
    const integration = await connectedIntegration();
    const { pass } = await startPassWhileTheCredentialIsAwaited();

    await rest('PUT', viewPath(integration.id), { body: { jql: NEW_JQL, fields: ['summary'] } });
    await releaseTheCredential();

    expect(readerCalls).toHaveLength(1);
    expect(jqlOfRead(0)).toBe(DEFAULT_QUERY);
    readerCalls[0]!.answer.resolve(okAnswer('CCM-1'));
    await pass;
  });
});

describe('a pass that waits for the answer of the provider', () => {
  const approvedIntegrationWithItsReadInFlight = async () => {
    const integration = await connectedIntegration();
    await humanApproves(integration.id, { jql: OLD_JQL, fields: ['summary'] });
    const pass = poll();
    await until(() => readerCalls.length === 1);
    return { integration, pass };
  };

  it('rejects the answer to the old query when a new configuration is approved meanwhile: no items, no ETag, no deadline written', async () => {
    const { integration, pass } = await approvedIntegrationWithItsReadInFlight();
    expect(jqlOfRead(0)).toBe(CANONICAL_OLD_JQL);

    await humanApproves(integration.id, { jql: NEW_JQL, fields: ['summary', 'status'] });
    readerCalls[0]!.answer.resolve(okAnswer('OLD-1', OLD_ETAG));
    await pass;

    expect(itemKeysOf(integration.id)).toEqual([]);
    expect(pollStateOf(integration.id)).toBeUndefined();
    expect(fixture.db.prepare('SELECT status FROM integration_health WHERE profile_id = ?').all(integration.id)).toEqual([]);
  });

  it('never sends the ETag of the old query with the new query, and asks the new query at once', async () => {
    const { integration, pass } = await approvedIntegrationWithItsReadInFlight();
    await humanApproves(integration.id, { jql: NEW_JQL, fields: ['summary', 'status'] });
    readerCalls[0]!.answer.resolve(okAnswer('OLD-1', OLD_ETAG));
    await pass;

    const nextPass = poll();
    await settle(20);

    expect(readerCalls).toHaveLength(2);
    expect(jqlOfRead(1)).toBe(CANONICAL_NEW_JQL);
    expect(fieldsOfRead(1)).toBe('summary,status');
    expect(readerCalls[1]!.get.headers['if-none-match']).toBeUndefined();
    readerCalls[1]!.answer.resolve(okAnswer('NEW-1'));
    await nextPass;
    expect(itemKeysOf(integration.id)).toEqual(['NEW-1']);
  });

  it('rejects a failure answered for the old query as well: it neither counts nor delays the new configuration', async () => {
    const { integration, pass } = await approvedIntegrationWithItsReadInFlight();
    await humanApproves(integration.id, { jql: NEW_JQL });

    readerCalls[0]!.answer.resolve({ kind: 'rate_limited', retryAfterSeconds: 3600 });
    await pass;

    expect(pollStateOf(integration.id)).toBeUndefined();
    expect(fixture.db.prepare('SELECT status FROM integration_health WHERE profile_id = ?').all(integration.id)).toEqual([]);
  });

  it('stores with the items the identity of the request that produced them, and keeps the old one until the new query has answered', async () => {
    const { integration, pass } = await approvedIntegrationWithItsReadInFlight();
    const identityOfTheRunningQuery = () => pollQueryOf(fixture.daemon.integrationRepository.findViewConfig(integration.id)).identity;
    const identityOfTheStoredItems = () => fixture.daemon.integrationRepository.listItemsWithQueryIdentity(integration.id).queryIdentity;
    const oldIdentity = identityOfTheRunningQuery();

    readerCalls[0]!.answer.resolve(okAnswer('OLD-1'));
    await pass;
    expect(identityOfTheStoredItems()).toBe(oldIdentity);

    await humanApproves(integration.id, { jql: NEW_JQL, fields: ['summary', 'status'] });
    expect(identityOfTheStoredItems()).toBe(oldIdentity);
    expect(identityOfTheRunningQuery()).not.toBe(oldIdentity);

    const nextPass = poll();
    await until(() => readerCalls.length === 2);
    readerCalls[1]!.answer.resolve(okAnswer('NEW-1'));
    await nextPass;
    expect(identityOfTheStoredItems()).toBe(identityOfTheRunningQuery());
  });

  it('keeps the answer when nothing changed during the read, a proposal included', async () => {
    const { integration, pass } = await approvedIntegrationWithItsReadInFlight();
    await rest('PUT', viewPath(integration.id), { body: { jql: NEW_JQL, fields: ['summary'] } });

    readerCalls[0]!.answer.resolve(okAnswer('OLD-1', OLD_ETAG));
    await pass;

    expect(itemKeysOf(integration.id)).toEqual(['OLD-1']);
    expect(pollStateOf(integration.id)).toMatchObject({ etag: OLD_ETAG, next_poll_at: new Date(START_OF_TEST_TIME + POLL_INTERVAL).toISOString() });
  });

  it('rejects the answer when the active row is edited in the database during the read', async () => {
    const { integration, pass } = await approvedIntegrationWithItsReadInFlight();

    fixture.db.prepare('UPDATE integration_view_configs SET active_jql = ? WHERE profile_id = ?').run('project = "ANYTHING"', integration.id);
    readerCalls[0]!.answer.resolve(okAnswer('OLD-1', OLD_ETAG));
    await pass;

    expect(itemKeysOf(integration.id)).toEqual([]);
  });
});
