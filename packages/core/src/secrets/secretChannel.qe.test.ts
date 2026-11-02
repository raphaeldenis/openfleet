import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_NONCE_HEADER, type SecretScope } from '@openfleet/shared';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon, type DaemonOptions } from '../daemon.js';
import { recentLogLines } from '../logger.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { createFakeTauriParent, keychainKeyOf, type FakeTauriParent } from './fakeTauriParent.testkit.js';

const tempDirs = createTempDirTracker();
const playbook: SecretScope = { kind: 'playbook', id: 'pb-1' };
const SECRET_NAME = 'JIRA_TOKEN';
const ANSWER_LIFETIME_MS = 30_000;

let daemon: Daemon;
let config: Config;
let parent: FakeTauriParent;
let monotonicMs: number;

const makeCanary = () => ['canary', randomUUID()].join('-');

const adminHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json', ...extra });

const declare = (database: Daemon['db']) =>
  database.prepare("INSERT OR IGNORE INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES (?, 'playbook', 'pb-1', ?, 'missing')").run(randomUUID(), SECRET_NAME);

const boot = async ({ withParent = true, exchangeTimeoutMs = 2_000 }: { withParent?: boolean; exchangeTimeoutMs?: number } = {}) => {
  const secrets: NonNullable<DaemonOptions['secrets']> = { monotonicClock: () => monotonicMs, exchangeTimeoutMs, ...(withParent ? { parent: parent.link } : {}) };
  daemon = await startDaemon(config, { secrets });
  declare(daemon.db);
};

const url = (path: string) => `${daemon.server.url}${path}`;

const put = (value: string) =>
  fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { method: 'PUT', headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce({ action: 'set', scope: playbook, name: SECRET_NAME }) }), body: JSON.stringify({ value }) });

const answerOf = async (response: Response) => ({ status: response.status, json: (await response.json()) as Record<string, unknown> });

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  monotonicMs = 1_000;
  parent = createFakeTauriParent();
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-secrets-channel-'), OPENFLEET_PORT: '0' });
});
afterEach(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('setting a secret through the desktop app', () => {
  beforeEach(() => boot());

  it('has the app write the value to its keychain and marks the secret stored', async () => {
    const value = makeCanary();

    const answer = await answerOf(await put(value));

    expect([answer.status, answer.json.status, parent.keychain.get(keychainKeyOf(playbook, SECRET_NAME))]).toEqual([200, 'stored', value]);
  });

  it('asks the app for the right operation on the right secret, each time under a fresh request id', async () => {
    await put(makeCanary());
    await put(makeCanary());

    const [first, second] = parent.requests;
    expect([first?.op, first?.scope, first?.name]).toEqual(['set', playbook, SECRET_NAME]);
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it('asks the app to clear the keychain item', async () => {
    await put(makeCanary());
    const cleared = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { method: 'DELETE', headers: adminHeaders({ [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce({ action: 'clear', scope: playbook, name: SECRET_NAME }) }) }));

    expect([cleared.json.status, parent.keychain.has(keychainKeyOf(playbook, SECRET_NAME))]).toEqual(['missing', false]);
  });

  it('answers 503 secret_store_unavailable when the keychain is locked, and the secret stays missing', async () => {
    parent.setBehaviour('keychain_locked');

    const answer = await answerOf(await put(makeCanary()));

    const status = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { headers: adminHeaders() }));
    expect([answer.status, answer.json.error, status.json.status]).toEqual([503, 'secret_store_unavailable', 'missing']);
  });

  it('serves no HTTP route for the exchange: there is nothing to answer in the app\'s place', () => {
    const exchangeRoutes = daemon.server.routes.filter(({ path }) => path.startsWith('/internal'));

    expect(exchangeRoutes).toEqual([]);
  });
});

describe('resolving a secret on demand', () => {
  beforeEach(() => boot());

  it('reads the value from the app each time it is asked, and keeps no copy', async () => {
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

  it('answers the status from its metadata and cannot set: no operator nonce can exist', async () => {
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

  it('fails the request with secret_store_unavailable, and a late answer changes nothing and is counted', async () => {
    parent.setBehaviour('stays_silent');

    const answer = await answerOf(await put(makeCanary()));

    parent.writeAnswer(parent.requests[0]!.requestId, { outcome: 'ok' });
    const status = await answerOf(await fetch(url(`/api/secrets/playbook/pb-1/${SECRET_NAME}`), { headers: adminHeaders() }));
    expect([answer.status, answer.json.error, status.json.status, daemon.secretChannel.ignoredAnswerCount()]).toEqual([503, 'secret_store_unavailable', 'missing', 1]);
  });
});

describe('answers that no request in flight claims', () => {
  beforeEach(async () => {
    await boot({ exchangeTimeoutMs: 400 });
    parent.setBehaviour('stays_silent');
  });

  const startPendingRead = async () => {
    const pending = daemon.secrets.resolve(playbook, SECRET_NAME).catch((error: unknown) => error);
    await nextTurn();
    return { pending, requestId: parent.requests[0]!.requestId };
  };

  it('accepts the answer of a request once: the same answer again is ignored and counted', async () => {
    const { pending, requestId } = await startPendingRead();

    parent.writeAnswer(requestId, { outcome: 'value', value: 'delivered-value-123' });
    parent.writeAnswer(requestId, { outcome: 'value', value: 'replayed-value-1234' });

    expect([await pending, daemon.secretChannel.ignoredAnswerCount()]).toEqual(['delivered-value-123', 1]);
  });

  it('ignores an answer after 30 seconds on the monotonic clock', async () => {
    const { pending, requestId } = await startPendingRead();
    monotonicMs += ANSWER_LIFETIME_MS + 1;

    parent.writeAnswer(requestId, { outcome: 'value', value: 'delivered-value-123' });

    expect(await pending).toMatchObject({ code: 'secret_store_unavailable' });
    expect(daemon.secretChannel.ignoredAnswerCount()).toBe(1);
  });

  it('ignores an answer to a request id nobody issued, and leaves the request in flight alone', async () => {
    const { pending, requestId } = await startPendingRead();

    parent.writeAnswer('forged-request-id', { outcome: 'value', value: 'forged-value-12345' });
    parent.writeAnswer(requestId, { outcome: 'value', value: 'delivered-value-123' });

    expect([await pending, daemon.secretChannel.ignoredAnswerCount()]).toEqual(['delivered-value-123', 1]);
  });

  it('ignores the answer of an older generation of the daemon', async () => {
    const { requestId: oldGenerationRequestId } = await startPendingRead();
    await daemon.close();
    parent.startNewGeneration();
    await boot({ exchangeTimeoutMs: 400 });
    const newPending = daemon.secrets.resolve(playbook, SECRET_NAME).catch((error: unknown) => error);
    await nextTurn();

    parent.writeAnswer(oldGenerationRequestId, { outcome: 'value', value: 'old-generation-value' });
    parent.writeAnswer(parent.requests.at(-1)!.requestId, { outcome: 'value', value: 'new-generation-value' });

    expect([await newPending, daemon.secretChannel.ignoredAnswerCount()]).toEqual(['new-generation-value', 1]);
  });
});

describe('where a value that crossed the pipes can appear', () => {
  beforeEach(() => boot());

  it('shows in no log line, activity row or diagnostics of the daemon', async () => {
    const setValue = makeCanary();
    const readValue = makeCanary();
    await put(setValue);
    parent.keychain.set(keychainKeyOf(playbook, SECRET_NAME), readValue);
    await daemon.secrets.resolve(playbook, SECRET_NAME);
    parent.writeAnswer('replayed-request-id', { outcome: 'value', value: makeCanary() });

    const activity = await (await fetch(url('/api/activity?limit=200'), { headers: adminHeaders() })).text();
    const diagnostics = await (await fetch(url('/api/diagnostics'), { headers: adminHeaders() })).text();

    const everywhere = [activity, diagnostics, ...recentLogLines()].join('\n');
    expect([everywhere.includes(setValue), everywhere.includes(readValue)]).toEqual([false, false]);
  });
});
