import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OPERATOR_NONCE_HEADER } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OTHER_PROJECT_ID, OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import type { IntegrationProvider } from '../integrations/integrationProviders.js';
import { recentLogLines } from '../logger.js';
import { createFakeTauriParent, type FakeTauriParent } from '../secrets/fakeTauriParent.testkit.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { ARBITER_TOOL_NAMES } from './arbiterTools.js';

type Client = Awaited<ReturnType<GovernanceFixture['connect']>>;
interface ProviderBehaviour { status: number; body: string; location?: string; delayMs: number }
interface SeenRequest { path: string; authorization: string | undefined }

const INTEGRATION_TOOLS = ['get_integration_health', 'list_integrations', 'refresh_integration'];
const COOLDOWN_MS = 60_000;
const START_OF_TEST_TIME = Date.parse('2026-11-06T10:00:00.000Z');
const TOKEN_SECRET = 'TOKEN';

const makeCanary = () => ['canary', randomUUID()].join('-');

/** A provider on 127.0.0.1 that answers what the test says and remembers who asked. */
const startFakeProvider = async () => {
  const behaviour: ProviderBehaviour = { status: 200, body: '{}', delayMs: 0 };
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization });
    setTimeout(() => {
      res.writeHead(behaviour.status, behaviour.location === undefined ? {} : { location: behaviour.location });
      res.end(behaviour.body);
    }, behaviour.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const stop = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return { behaviour, seen, port, stop };
};
type FakeProvider = Awaited<ReturnType<typeof startFakeProvider>>;

const providerOn = (port: number): IntegrationProvider => ({
  id: 'fake', scheme: 'http', port, isHostAllowed: (host) => host === '127.0.0.1', healthPath: '/health', authorizationOf: (credential) => `Bearer ${credential}`,
});

let fixture: GovernanceFixture;
let lead: Client;
let provider: FakeProvider;
let bystander: FakeProvider;
let parent: FakeTauriParent;
let store: InMemorySecretStore;
let now: number;

beforeEach(async () => {
  provider = await startFakeProvider();
  bystander = await startFakeProvider();
  store = createInMemorySecretStore();
  parent = createFakeTauriParent();
  now = START_OF_TEST_TIME;
  fixture = await startGovernanceFixture({
    secrets: { store, parent: parent.link },
    integrations: { providers: [providerOn(provider.port)], clock: () => now, refreshCooldownMs: COOLDOWN_MS },
  });
  lead = await fixture.connect(fixture.lead.id);
});
afterEach(async () => {
  await fixture.close();
  await provider.stop();
  await bystander.stop();
});

const rest = async (method: string, path: string, body?: unknown) => {
  const response = await fixture.api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, json: text.length > 0 ? JSON.parse(text) : undefined };
};
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text, json: result.isError === true ? undefined : JSON.parse(text) };
};

const connectionBody = (overrides: Record<string, unknown> = {}) => ({ name: 'Fake', provider: 'fake', allowedHosts: ['127.0.0.1'], ...overrides });
const createConnection = async (overrides: Record<string, unknown> = {}) => (await rest('POST', '/api/integration-connections', connectionBody(overrides))).json as { id: string };
const createIntegration = async (connectionId: string, overrides: Record<string, unknown> = {}) =>
  (await rest('POST', '/api/integrations', { projectId: OWN_PROJECT_ID, connectionId, name: 'Backlog', resource: 'CCM', ...overrides })).json as { id: string };
const setTokenAsHuman = async (connectionId: string, value: string) => {
  const nonce = parent.mintOperatorNonce({ action: 'set', scope: { kind: 'connection', id: connectionId }, name: TOKEN_SECRET });
  const response = await fixture.api(`/api/secrets/connection/${connectionId}/${TOKEN_SECRET}`, { method: 'PUT', headers: { [OPERATOR_NONCE_HEADER]: nonce }, body: JSON.stringify({ value }) });
  return response.status;
};
const connectedIntegration = async (value = makeCanary()) => {
  const connection = await createConnection();
  const integration = await createIntegration(connection.id);
  await setTokenAsHuman(connection.id, value);
  return { connection, integration, value };
};

describe('creating a connection and an integration (REST, admin token)', () => {
  it('records a connection whose credential is missing, names its hosts in lower case and lists it', async () => {
    const created = await rest('POST', '/api/integration-connections', connectionBody({ name: 'Jira' }));
    const listed = await rest('GET', '/api/integration-connections');

    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Jira', provider: 'fake', credentialKind: 'token', allowedHosts: ['127.0.0.1'], credential: 'missing' });
    expect(listed.json).toEqual([created.json]);
  });

  it('declares the TOKEN secret of the connection so that a human can set it, and shows it stored afterwards without its value', async () => {
    const connection = await createConnection();
    const value = makeCanary();

    const statusBefore = await rest('GET', `/api/secrets/connection/${connection.id}/${TOKEN_SECRET}`);
    await setTokenAsHuman(connection.id, value);
    const listed = await rest('GET', '/api/integration-connections');

    expect(statusBefore.json).toMatchObject({ scopeKind: 'connection', name: TOKEN_SECRET, status: 'missing' });
    expect(listed.json[0]).toMatchObject({ credential: 'stored' });
    expect(listed.text.includes(value)).toBe(false);
  });

  it('refuses a provider the daemon does not know, naming the known ones', async () => {
    const answer = await rest('POST', '/api/integration-connections', connectionBody({ provider: 'carrier-pigeon' }));

    expect(answer.status).toBe(400);
    expect(answer.json).toMatchObject({ error: 'integration_provider_unknown' });
    expect(answer.json.hint).toContain('fake');
  });

  it.each([
    ['another host name', 'localhost'],
    ['a look-alike suffix', '127.0.0.1.evil.example'],
    ['a port', '127.0.0.1:9999'],
    ['a scheme', 'http://127.0.0.1'],
    ['a path', '127.0.0.1/rest'],
    ['a user', 'admin@127.0.0.1'],
    ['a blank', ' '],
  ])('refuses a host that is %s: a provider reaches its own hosts and no free url', async (_why, host) => {
    const answer = await rest('POST', '/api/integration-connections', connectionBody({ allowedHosts: [host] }));

    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatch(/^integration_host_not_allowed$|^invalid_body$/);
  });

  it('refuses the whole connection when one of its hosts is not allowed', async () => {
    const answer = await rest('POST', '/api/integration-connections', connectionBody({ allowedHosts: ['127.0.0.1', 'evil.example'] }));

    expect(answer.json).toMatchObject({ error: 'integration_host_not_allowed' });
    expect((await rest('GET', '/api/integration-connections')).json).toEqual([]);
  });

  it('refuses a body that carries a credential: the value is set through the secrets route and nowhere else', async () => {
    const value = makeCanary();

    const answer = await rest('POST', '/api/integration-connections', connectionBody({ token: value }));

    expect(answer.status).toBe(400);
    expect(answer.text.includes(value)).toBe(false);
    expect((await rest('GET', '/api/integration-connections')).json).toEqual([]);
  });

  it('refuses a second connection of the same name, an integration of an unknown connection and one of an unknown project', async () => {
    const connection = await createConnection();

    expect((await rest('POST', '/api/integration-connections', connectionBody())).json).toMatchObject({ error: 'duplicate_name' });
    expect((await rest('POST', '/api/integrations', { projectId: OWN_PROJECT_ID, connectionId: 'ghost', name: 'X' })).json).toMatchObject({ error: 'integration_connection_not_found' });
    expect((await rest('POST', '/api/integrations', { projectId: 'ghost', connectionId: connection.id, name: 'X' })).json).toMatchObject({ error: 'project_not_found' });
  });

  it('answers 401 without the admin token', async () => {
    const response = await fetch(`${fixture.daemon.server.url}/api/integration-connections`);

    expect(response.status).toBe(401);
  });
});

describe('the integration tools of a manager', () => {
  it('are exactly list_integrations, get_integration_health and refresh_integration, and none takes a credential, a host or a url', async () => {
    const tools = (await lead.listTools()).tools.filter((candidate) => /integration|secret_set|credential/.test(candidate.name) && !/playbook_secret/.test(candidate.name));

    expect(tools.map((candidate) => candidate.name).sort()).toEqual(INTEGRATION_TOOLS);
    const parameterNames = tools.flatMap((candidate) => Object.keys((candidate.inputSchema as { properties?: object }).properties ?? {}));
    expect(parameterNames.filter((name) => /token|secret|credential|password|authorization|value|host|url/i.test(name))).toEqual([]);
  });

  it('list the integrations of the project of the caller only, with the status of the credential and an unknown health before any refresh', async () => {
    const { connection, integration } = await connectedIntegration();
    await rest('POST', '/api/integrations', { projectId: OTHER_PROJECT_ID, connectionId: connection.id, name: 'Foreign' });

    const { json } = await tool(lead, 'list_integrations');

    expect(json.integrations).toEqual([{ id: integration.id, project_id: OWN_PROJECT_ID, connection_id: connection.id, name: 'Backlog', provider: 'fake', resource: 'CCM', credential: 'stored', health: 'unknown' }]);
  });

  it('read an integration of another project exactly like one that does not exist', async () => {
    const connection = await createConnection();
    const foreign = await createIntegration(connection.id, { projectId: OTHER_PROJECT_ID });

    const health = await tool(lead, 'get_integration_health', { integration: foreign.id });
    const refresh = await tool(lead, 'refresh_integration', { integration: foreign.id });

    expect(health.text).toMatch(/^error integration_not_found:/);
    expect(refresh.text).toMatch(/^error integration_not_found:/);
    expect(provider.seen).toEqual([]);
  });

  it('report a connection with no value on this device as not connected and call nobody', async () => {
    const connection = await createConnection();
    const integration = await createIntegration(connection.id);

    const refresh = await tool(lead, 'refresh_integration', { integration: integration.id });
    const health = await tool(lead, 'get_integration_health', { integration: integration.id });

    expect(refresh.text).toMatch(/^error secret_not_connected_on_this_device:/);
    expect(health.json).toMatchObject({ credential: 'missing', health: 'unknown' });
    expect(provider.seen).toEqual([]);
  });

  it('are hidden from a reviewer and absent from the fixed tool set of an arbiter', async () => {
    const reviewer = await fixture.connect((await fixture.createSession('Reviewer', { role: 'reviewer' })).id);

    const reviewerTools = (await reviewer.listTools()).tools.map((candidate) => candidate.name);

    expect(reviewerTools.filter((name) => INTEGRATION_TOOLS.includes(name))).toEqual([]);
    expect(INTEGRATION_TOOLS.filter((name) => [...ARBITER_TOOL_NAMES].includes(name))).toEqual([]);
  });
});

describe('refresh_integration', () => {
  it('presents the credential to the provider, asks its health path once and records ok, readable afterwards without a new call', async () => {
    const { integration, value } = await connectedIntegration();

    const refreshed = await tool(lead, 'refresh_integration', { integration: integration.id });
    const health = await tool(lead, 'get_integration_health', { integration: integration.id });

    expect(provider.seen).toEqual([{ path: '/health', authorization: `Bearer ${value}` }]);
    expect(refreshed.json).toMatchObject({ id: integration.id, health: 'ok', credential: 'stored', checked_at: new Date(now).toISOString() });
    expect(health.json).toEqual(refreshed.json);
    expect(provider.seen).toHaveLength(1);
  });

  it.each([
    [200, 'ok'], [204, 'ok'],
    [401, 'auth_failed'], [403, 'auth_failed'],
    [429, 'rate_limited'],
    [404, 'unreachable'], [500, 'unreachable'], [503, 'unreachable'],
  ])('types the answer %i of the provider as %s', async (status, expectedHealth) => {
    const { integration } = await connectedIntegration();
    provider.behaviour.status = status;

    const { json } = await tool(lead, 'refresh_integration', { integration: integration.id });

    expect(json.health).toBe(expectedHealth);
  });

  it('types a provider that does not answer as unreachable', async () => {
    const { integration } = await connectedIntegration();
    await provider.stop();

    const { json } = await tool(lead, 'refresh_integration', { integration: integration.id });

    expect(json.health).toBe('unreachable');
  });

  it('does not follow a redirect: the credential reaches the host asked and no other, and the health reads unreachable', async () => {
    const { integration } = await connectedIntegration();
    provider.behaviour.status = 302;
    provider.behaviour.location = `http://127.0.0.1:${bystander.port}/steal`;

    const { json } = await tool(lead, 'refresh_integration', { integration: integration.id });

    expect(json.health).toBe('unreachable');
    expect(bystander.seen).toEqual([]);
  });

  it('returns nothing the provider said, whatever its body holds', async () => {
    const { integration, value } = await connectedIntegration();
    const thirdPartyMarker = `marker-${randomUUID()}`;
    provider.behaviour.body = JSON.stringify({ note: thirdPartyMarker, echoedCredential: value });

    const refreshed = await tool(lead, 'refresh_integration', { integration: integration.id });
    const health = await tool(lead, 'get_integration_health', { integration: integration.id });

    expect([refreshed.text, health.text].join('\n')).not.toMatch(new RegExp(`${thirdPartyMarker}|${value}`));
  });

  it('refuses a second refresh inside the cooldown without a second call, and allows one when the cooldown has passed', async () => {
    const { integration } = await connectedIntegration();
    await tool(lead, 'refresh_integration', { integration: integration.id });

    const tooSoon = await tool(lead, 'refresh_integration', { integration: integration.id });
    now += COOLDOWN_MS - 1000;
    const stillTooSoon = await tool(lead, 'refresh_integration', { integration: integration.id });
    now += 1000;
    const afterCooldown = await tool(lead, 'refresh_integration', { integration: integration.id });

    expect(tooSoon.text).toMatch(/^error integration_refresh_cooldown:/);
    expect(stillTooSoon.text).toMatch(/^error integration_refresh_cooldown:/);
    expect(afterCooldown.json.health).toBe('ok');
    expect(provider.seen).toHaveLength(2);
  });

  it('lets one of two simultaneous refreshes through: a burst makes one call', async () => {
    const { integration } = await connectedIntegration();
    provider.behaviour.delayMs = 150;

    const answers = await Promise.all([tool(lead, 'refresh_integration', { integration: integration.id }), tool(lead, 'refresh_integration', { integration: integration.id })]);

    expect(answers.filter((answer) => answer.isError).map((answer) => answer.text.slice(0, 40))).toEqual([expect.stringMatching(/^error integration_refresh_cooldown:/)]);
    expect(provider.seen).toHaveLength(1);
  });

  it('counts the cooldown per integration: another integration refreshes at once', async () => {
    const { connection, integration } = await connectedIntegration();
    const second = await createIntegration(connection.id, { name: 'Second' });
    await tool(lead, 'refresh_integration', { integration: integration.id });

    const other = await tool(lead, 'refresh_integration', { integration: second.id });

    expect(other.json.health).toBe('ok');
  });
});

describe('where the credential can appear', () => {
  it('is in the secret store and the request to the provider, and in no answer, table, log line, activity row, diagnostics or database file', async () => {
    const { connection, integration, value } = await connectedIntegration();
    const answers: string[] = [];
    const record = async (answer: Promise<{ text: string }>) => void answers.push((await answer).text);
    provider.behaviour.body = JSON.stringify({ echoedCredential: value });

    await record(tool(lead, 'refresh_integration', { integration: integration.id }));
    await record(tool(lead, 'refresh_integration', { integration: integration.id }));
    await record(tool(lead, 'get_integration_health', { integration: integration.id }));
    await record(tool(lead, 'list_integrations'));
    await record(tool(lead, 'get_integration_health', { integration: 'ghost', token: value }));
    await record(tool(lead, 'refresh_integration', { integration: 'ghost', token: value, authorization: value }));
    await record(rest('GET', '/api/integration-connections'));
    await record(rest('GET', `/api/integrations?projectId=${OWN_PROJECT_ID}`));
    await record(rest('POST', '/api/integration-connections', connectionBody({ name: value, token: value })));
    await record(rest('POST', '/api/integration-connections', connectionBody({ name: 'Other', allowedHosts: [value] })));
    await record(rest('POST', '/api/integrations', { projectId: OWN_PROJECT_ID, connectionId: connection.id, name: 'Dup', credential: value }));
    provider.behaviour.status = 401;
    now += COOLDOWN_MS;
    await record(tool(lead, 'refresh_integration', { integration: integration.id }));
    const activity = (await rest('GET', '/api/activity?limit=200')).text;
    const diagnostics = (await rest('GET', '/api/diagnostics')).text;
    const everyTable = (fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(({ name }) => JSON.stringify(fixture.db.prepare(`SELECT * FROM "${name}"`).all()));
    const databaseFile = (fixture.db.prepare('PRAGMA database_list').all() as { file: string }[])[0]!.file;
    const databaseBytes = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].flatMap((path) => {
      try { return [readFileSync(path).toString('latin1')]; } catch { return []; }
    });

    const everywhere = [...answers, activity, diagnostics, ...everyTable, ...recentLogLines(), ...databaseBytes].join('\n');
    expect(store.valueOf({ kind: 'connection', id: connection.id }, TOKEN_SECRET)).toBe(value);
    expect(provider.seen.every((request) => request.authorization === `Bearer ${value}`)).toBe(true);
    expect(everywhere.includes(value)).toBe(false);
    expect(everywhere.includes(Buffer.from(value).toString('base64'))).toBe(false);
    expect(activity).toContain('refresh_integration');
  });
});
