import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_NONCE_HEADER, type SecretScope } from '@openfleet/shared';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { recentLogLines } from '../logger.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { createFakeTauriParent, type FakeTauriParent } from '../secrets/fakeTauriParent.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
const playbook: SecretScope = { kind: 'playbook', id: 'pb-1' };
const SECRET_NAME = 'JIRA_TOKEN';

let daemon: Daemon;
let config: Config;
let parent: FakeTauriParent;
let store: InMemorySecretStore;
let responseTexts: string[];

const makeCanary = () => ['canary', randomUUID()].join('-');

const declare = (scope: SecretScope, name: string) =>
  daemon.db.prepare("INSERT INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES (?, ?, ?, ?, 'missing')").run(randomUUID(), scope.kind, scope.id, name);

const pathOf = (scope: SecretScope, name: string) => `${daemon.server.url}/api/secrets/${scope.kind}/${scope.id}/${name}`;

const adminHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json', ...extra });

const call = async (method: string, url: string, init: { headers?: Record<string, string>; body?: unknown } = {}) => {
  const response = await fetch(url, { method, headers: init.headers ?? adminHeaders(), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const text = await response.text();
  responseTexts.push(text);
  return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

const setSecret = (value: string, { nonce = parent.mintOperatorNonce(), scope = playbook, name = SECRET_NAME } = {}) =>
  call('PUT', pathOf(scope, name), { headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: nonce }), body: { value } });

const clearSecret = (nonce = parent.mintOperatorNonce(), scope = playbook, name = SECRET_NAME) =>
  call('DELETE', pathOf(scope, name), { headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: nonce }) });

beforeEach(async () => {
  responseTexts = [];
  store = createInMemorySecretStore();
  parent = createFakeTauriParent();
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-secrets-rest-'), OPENFLEET_PORT: '0' });
  daemon = await startDaemon(config, { secrets: { store, parent: parent.link } });
  declare(playbook, SECRET_NAME);
});
afterEach(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('PUT, DELETE and GET /api/secrets/:scopeKind/:scopeId/:name on a booted daemon', () => {
  it('reads missing for a declared name, stored after a set, missing after a clear', async () => {
    const before = await call('GET', pathOf(playbook, SECRET_NAME));
    const set = await setSecret(makeCanary());
    const afterSet = await call('GET', pathOf(playbook, SECRET_NAME));
    const cleared = await clearSecret();
    const afterClear = await call('GET', pathOf(playbook, SECRET_NAME));

    expect([before.json.status, set.status, set.json.status, afterSet.json.status, cleared.status, afterClear.json.status]).toEqual(['missing', 200, 'stored', 'stored', 200, 'missing']);
  });

  it('hands the value to the secret store and to nobody else', async () => {
    const value = makeCanary();

    await setSecret(value);

    expect(store.valueOf(playbook, SECRET_NAME)).toBe(value);
  });

  it('answers a clear of an already cleared secret the same way (idempotent)', async () => {
    await setSecret(makeCanary());
    await clearSecret();

    const second = await clearSecret();

    expect([second.status, second.json.status]).toEqual([200, 'missing']);
  });

  it('records who set the secret and when, as metadata', async () => {
    await setSecret(makeCanary());

    const row = daemon.db.prepare('SELECT status, set_by, set_at FROM secret_refs WHERE name = ?').get(SECRET_NAME) as { status: string; set_by: string; set_at: string };

    expect([row.status, row.set_by, Number.isNaN(Date.parse(row.set_at))]).toEqual(['stored', 'admin', false]);
  });

  it('answers 404 secret_scope_not_found for a scope no secret is declared under', async () => {
    const answer = await call('GET', pathOf({ kind: 'playbook', id: 'no-such-playbook' }, SECRET_NAME));

    expect([answer.status, answer.json.error]).toEqual([404, 'secret_scope_not_found']);
  });

  it('answers 404 secret_not_declared for an undeclared name under a known scope', async () => {
    const answer = await setSecret(makeCanary(), { name: 'OTHER_NAME' });

    expect([answer.status, answer.json.error]).toEqual([404, 'secret_not_declared']);
  });

  it('answers 400 for a scope kind that does not exist', async () => {
    const answer = await call('GET', `${daemon.server.url}/api/secrets/planet/pb-1/${SECRET_NAME}`);

    expect([answer.status, answer.json.error]).toEqual([400, 'invalid_body']);
  });

  it('refuses a value of 7 characters with a stable code and keeps the secret missing', async () => {
    const answer = await setSecret('1234567');

    const status = await call('GET', pathOf(playbook, SECRET_NAME));

    expect([answer.status, answer.json.error, status.json.status, store.valueOf(playbook, SECRET_NAME)]).toEqual([400, 'secret_too_short', 'missing', undefined]);
  });

  it('accepts a value of exactly 8 characters', async () => {
    const answer = await setSecret('12345678');

    expect(answer.status).toBe(200);
  });

  it.each([
    ['a body with another field', { value: '12345678-abc', other: 1 }],
    ['a body without a value', {}],
    ['a value that is not a string', { value: 12345678 }],
  ])('refuses %s', async (_label, body) => {
    const answer = await call('PUT', pathOf(playbook, SECRET_NAME), { headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }), body });

    expect([answer.status, answer.json.error]).toEqual([400, 'invalid_body']);
  });

  it('ignores a value in the query string: the body is the only way in', async () => {
    const answer = await call('PUT', `${pathOf(playbook, SECRET_NAME)}?value=query-string-value`, { headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }) });

    expect([answer.status, store.valueOf(playbook, SECRET_NAME)]).toEqual([400, undefined]);
  });
});

describe('who may set or clear a secret', () => {
  it.each([
    ['no token at all', {}],
    ['a token of a session (the MCP token)', { authorization: 'Bearer not-the-admin-token' }],
  ])('answers 401 to %s', async (_label, headers) => {
    const answer = await call('PUT', pathOf(playbook, SECRET_NAME), { headers: { ...headers, [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }, body: { value: makeCanary() } });

    expect([answer.status, store.valueOf(playbook, SECRET_NAME)]).toEqual([401, undefined]);
  });

  it('answers 401 secret_nonce_invalid to an admin token without a nonce, for a set and for a clear', async () => {
    const set = await call('PUT', pathOf(playbook, SECRET_NAME), { body: { value: makeCanary() } });
    const clear = await call('DELETE', pathOf(playbook, SECRET_NAME));

    expect([set.status, set.json.error, clear.status, clear.json.error]).toEqual([401, 'secret_nonce_invalid', 401, 'secret_nonce_invalid']);
  });

  it('answers 401 to a nonce nobody minted', async () => {
    const answer = await setSecret(makeCanary(), { nonce: 'made-up-by-an-agent' });

    expect([answer.status, answer.json.error]).toEqual([401, 'secret_nonce_invalid']);
  });

  it('spends the nonce: the second request with the same nonce answers 401', async () => {
    const nonce = parent.mintOperatorNonce();
    const first = await setSecret(makeCanary(), { nonce });

    const second = await setSecret(makeCanary(), { nonce });

    expect([first.status, second.status]).toEqual([200, 401]);
  });

  it('lets a status read through with the admin token alone', async () => {
    const answer = await call('GET', pathOf(playbook, SECRET_NAME));

    expect(answer.status).toBe(200);
  });
});

describe('where a secret value can appear', () => {
  it('never shows the value in an answer, a log line, the activity log, the diagnostics or the SQLite file', async () => {
    const value = makeCanary();
    const tooShort = makeCanary().slice(0, 7);

    await setSecret(value);
    await call('GET', pathOf(playbook, SECRET_NAME));
    await setSecret(tooShort);
    await setSecret(value, { name: 'UNDECLARED' });
    await call('PUT', pathOf(playbook, SECRET_NAME), { headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }), body: { value, other: value } });
    await clearSecret();
    const activity = await call('GET', `${daemon.server.url}/api/activity`);
    const diagnostics = await call('GET', `${daemon.server.url}/api/diagnostics`);
    await daemon.close();
    const databaseFiles = [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].flatMap((path) => {
      try {
        return [readFileSync(path).toString('latin1')];
      } catch {
        return [];
      }
    });

    const everywhere = [...responseTexts, activity.text, diagnostics.text, ...recentLogLines(), ...databaseFiles].join('\n');
    expect([everywhere.includes(value), everywhere.includes(tooShort)]).toEqual([false, false]);
    daemon = await startDaemon(config, { secrets: { store, parent: parent.link } });
  });
});
