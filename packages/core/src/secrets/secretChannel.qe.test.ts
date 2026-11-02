import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_NONCE_HEADER, type SecretScope } from '@openfleet/shared';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon, type DaemonOptions } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { createFakeTauriParent, keychainKeyOf, type FakeTauriParent } from './fakeTauriParent.testkit.js';

const tempDirs = createTempDirTracker();
const playbook: SecretScope = { kind: 'playbook', id: 'pb-1' };
const SECRET_NAME = 'JIRA_TOKEN';
const NONCE_LIFETIME_MS = 30_000;

let daemon: Daemon;
let config: Config;
let parent: FakeTauriParent;
let nowMs: number;

const makeCanary = () => ['canary', randomUUID()].join('-');

const adminHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json', ...extra });

const boot = async ({ withParent = true, exchangeTimeoutMs = 2_000 }: { withParent?: boolean; exchangeTimeoutMs?: number } = {}) => {
  const secrets: NonNullable<DaemonOptions['secrets']> = { clock: () => nowMs, exchangeTimeoutMs, ...(withParent ? { parent: parent.link } : {}) };
  daemon = await startDaemon(config, { secrets });
  daemon.db.prepare("INSERT INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES (?, 'playbook', 'pb-1', ?, 'missing')").run(randomUUID(), SECRET_NAME);
};

const url = (path: string) => `${daemon.server.url}${path}`;

const put = (value: string) =>
  fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { method: 'PUT', headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }), body: JSON.stringify({ value }) });

const answerOf = async (response: Response) => ({ status: response.status, json: (await response.json()) as Record<string, unknown> });

const postInternal = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  nowMs = Date.parse('2026-11-02T10:00:00.000Z');
  parent = createFakeTauriParent({ daemonUrl: () => daemon.server.url });
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-secrets-channel-'), OPENFLEET_PORT: '0' });
});
afterEach(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('setting a secret through the desktop app', () => {
  beforeEach(() => boot());

  it('puts the value in the keychain of the app and nowhere in what the daemon printed to it', async () => {
    const value = makeCanary();

    const answer = await answerOf(await put(value));

    expect([answer.status, answer.json.status, parent.keychain.get(keychainKeyOf(playbook, SECRET_NAME))]).toEqual([200, 'stored', value]);
    expect(JSON.stringify(parent.requests).includes(value)).toBe(false);
  });

  it('asks the app for the right operation on the right secret, each with fresh nonces', async () => {
    await put(makeCanary());
    await put(makeCanary());

    const [first, second] = parent.requests;
    expect([first?.op, first?.scope, first?.name]).toEqual(['set', playbook, SECRET_NAME]);
    expect(new Set([first?.deliverNonce, first?.takeNonce, second?.deliverNonce, second?.takeNonce]).size).toBe(4);
  });

  it('asks the app to clear the keychain item', async () => {
    await put(makeCanary());
    const cleared = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { method: 'DELETE', headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }) }));

    expect([cleared.json.status, parent.keychain.has(keychainKeyOf(playbook, SECRET_NAME))]).toEqual(['missing', false]);
  });

  it('answers 503 secret_store_unavailable when the keychain is locked, and the secret stays missing', async () => {
    parent.setBehaviour('keychain_locked');

    const answer = await answerOf(await put(makeCanary()));

    const status = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { headers: adminHeaders() }));
    expect([answer.status, answer.json.error, status.json.status]).toEqual([503, 'secret_store_unavailable', 'missing']);
  });
});

describe('resolving a secret on demand', () => {
  beforeEach(() => boot());

  it('reads the value from the app each time it is asked, and keeps no copy', async () => {
    await put(makeCanary());
    parent.keychain.set(keychainKeyOf(playbook, SECRET_NAME), 'first-value-in-the-keychain');
    const first = await daemon.secrets.resolve(playbook, SECRET_NAME);
    parent.keychain.set(keychainKeyOf(playbook, SECRET_NAME), 'second-value-in-the-keychain');

    const second = await daemon.secrets.resolve(playbook, SECRET_NAME);

    const reads = parent.requests.filter((request) => request.op === 'read');
    expect([first, second, reads.length]).toEqual(['first-value-in-the-keychain', 'second-value-in-the-keychain', 2]);
  });

  it('fails with "not connected on this device" when the name is declared but the keychain has no value', async () => {
    const failure = await daemon.secrets.resolve(playbook, SECRET_NAME).catch((error: unknown) => error as { code: string; message: string });

    expect(failure).toMatchObject({ code: 'secret_not_connected_on_this_device', message: expect.stringContaining('not connected on this device') });
  });

  it('fails with secret_store_unavailable when the keychain is locked', async () => {
    parent.setBehaviour('keychain_locked');

    const failure = await daemon.secrets.resolve(playbook, SECRET_NAME).catch((error: unknown) => error as { code: string });

    expect(failure).toMatchObject({ code: 'secret_store_unavailable' });
  });
});

describe('a daemon without the desktop app', () => {
  beforeEach(() => boot({ withParent: false }));

  it('answers the status from its metadata and refuses to set, typed', async () => {
    const status = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { headers: adminHeaders() }));
    const set = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { method: 'PUT', headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: 'any-nonce' }), body: JSON.stringify({ value: makeCanary() }) }));

    expect([status.json.status, set.status]).toEqual(['missing', 401]);
  });

  it('refuses to resolve with secret_store_unavailable', async () => {
    const failure = await daemon.secrets.resolve(playbook, SECRET_NAME).catch((error: unknown) => error as { code: string });

    expect(failure).toMatchObject({ code: 'secret_store_unavailable' });
  });
});

describe('an app that does not answer', () => {
  beforeEach(() => boot({ exchangeTimeoutMs: 100 }));

  it('fails the request with secret_store_unavailable and spends the nonces, so a late answer is refused', async () => {
    parent.setBehaviour('stays_silent');

    const answer = await answerOf(await put(makeCanary()));

    const late = await postInternal('/internal/secrets/deliver', { nonce: parent.requests[0]?.deliverNonce, outcome: 'ok' });
    expect([answer.status, answer.json.error, late.status]).toEqual([503, 'secret_store_unavailable', 401]);
  });
});

describe('the internal routes the desktop app answers on', () => {
  beforeEach(async () => {
    await boot({ exchangeTimeoutMs: 400 });
    parent.setBehaviour('stays_silent');
  });

  const requestPendingRead = async () => {
    const pending = daemon.secrets.resolve(playbook, SECRET_NAME).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { pending, request: parent.requests[0]! };
  };

  it('accepts the nonce once: a second delivery with the same nonce is refused', async () => {
    const { pending, request } = await requestPendingRead();

    const first = await postInternal('/internal/secrets/deliver', { nonce: request.deliverNonce, outcome: 'value', value: 'delivered-value-123' });
    const second = await postInternal('/internal/secrets/deliver', { nonce: request.deliverNonce, outcome: 'value', value: 'another-value-1234' });

    expect([first.status, second.status, await pending]).toEqual([200, 401, 'delivered-value-123']);
  });

  it('refuses a nonce older than 30 seconds', async () => {
    const { pending, request } = await requestPendingRead();
    nowMs += NONCE_LIFETIME_MS + 1;

    const late = await postInternal('/internal/secrets/deliver', { nonce: request.deliverNonce, outcome: 'value', value: 'delivered-value-123' });

    expect(late.status).toBe(401);
    expect(await pending).toMatchObject({ code: 'secret_store_unavailable' });
  });

  it('refuses a nonce nobody issued', async () => {
    await requestPendingRead();

    const forged = await postInternal('/internal/secrets/deliver', { nonce: 'forged', outcome: 'value', value: 'forged-value-12345' });

    expect(forged.status).toBe(401);
  });

  it('counts the nonce only: the admin token alone does not deliver', async () => {
    const { request } = await requestPendingRead();

    const withAdminToken = await postInternal('/internal/secrets/deliver', { outcome: 'value', value: 'forged-value-12345' }, adminHeaders());
    const nonceAndAdminToken = await postInternal('/internal/secrets/deliver', { nonce: request.deliverNonce, outcome: 'value', value: 'forged-value-12345' }, adminHeaders());

    expect([withAdminToken.status, nonceAndAdminToken.status]).toEqual([401, 401]);
  });

  it('refuses a request that carries a bearer token of a session', async () => {
    const { request } = await requestPendingRead();

    const answer = await postInternal('/internal/secrets/deliver', { nonce: request.deliverNonce, outcome: 'ok' }, { authorization: 'Bearer some-session-mcp-token' });

    expect(answer.status).toBe(401);
  });

  it('refuses a request that carries an Origin header (a browser page)', async () => {
    const { request } = await requestPendingRead();

    const answer = await postInternal('/internal/secrets/deliver', { nonce: request.deliverNonce, outcome: 'ok' }, { origin: 'http://evil.example' });

    expect(answer.status).toBe(401);
  });

  it('gives the pending value of a set once, to the take nonce only', async () => {
    const value = makeCanary();
    const setting = put(value);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const request = parent.requests[0]!;

    const withDeliverNonce = await postInternal('/internal/secrets/take', { nonce: request.deliverNonce });
    const first = await postInternal('/internal/secrets/take', { nonce: request.takeNonce });
    const second = await postInternal('/internal/secrets/take', { nonce: request.takeNonce });

    expect([withDeliverNonce.status, first.status, ((await first.json()) as { value: string }).value, second.status]).toEqual([401, 200, value, 401]);
    await setting;
  });
});
