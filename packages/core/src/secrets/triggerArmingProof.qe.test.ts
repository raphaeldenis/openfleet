import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { createFakeTauriParent, type FakeTauriParent } from './fakeTauriParent.testkit.js';
import { createInMemorySecretStore } from './inMemorySecretStore.js';

const tempDirs = createTempDirTracker();
const PROJECT_ID = 'project-arming';
const HUMAN_PROOF_HEADER = 'x-human-proof';

let daemon: Daemon;
let config: Config;
let parent: FakeTauriParent;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...init.headers } });

const createTrigger = async (title: string): Promise<string> => {
  const response = await api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, ownerManagerId: null, title }) });
  return ((await response.json()) as { id: string }).id;
};

const armingNonceFor = (triggerId: string) => parent.mintOperatorNonce({ action: 'trigger.arm', scope: { kind: 'trigger', id: triggerId }, name: triggerId });

const arm = (triggerId: string, proof?: string) =>
  api(`/api/triggers/${triggerId}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev: 1 }), headers: proof === undefined ? {} : { [HUMAN_PROOF_HEADER]: proof } });

const armedAtOf = async (triggerId: string) => ((await (await api(`/api/triggers/${triggerId}`)).json()) as { armedAt: string | null }).armedAt;

beforeEach(async () => {
  parent = createFakeTauriParent();
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-arming-proof-'), OPENFLEET_PORT: '0' });
  daemon = await startDaemon(config, { secrets: { store: createInMemorySecretStore(), parent: parent.link } });
  daemon.db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Arming', 'now')").run(PROJECT_ID);
});
afterEach(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('arming a trigger with the operator nonce of the desktop app, on a booted daemon', () => {
  it('arms the trigger the nonce was minted for', async () => {
    const triggerId = await createTrigger('Nightly');

    const response = await arm(triggerId, armingNonceFor(triggerId));

    expect(response.status).toBe(200);
    expect(await armedAtOf(triggerId)).toEqual(expect.any(String));
  });

  it('refuses a nonce minted for another trigger, and spends it', async () => {
    const trigger = await createTrigger('Nightly');
    const otherTrigger = await createTrigger('Weekly');
    const nonceOfOtherTrigger = armingNonceFor(otherTrigger);

    const refusedOnTheWrongTrigger = await arm(trigger, nonceOfOtherTrigger);
    const refusedOnItsOwnTriggerAfterwards = await arm(otherTrigger, nonceOfOtherTrigger);

    expect([refusedOnTheWrongTrigger.status, refusedOnItsOwnTriggerAfterwards.status]).toEqual([401, 401]);
    expect(await armedAtOf(trigger)).toBeNull();
    expect(await armedAtOf(otherTrigger)).toBeNull();
  });

  it('refuses a nonce that was already used', async () => {
    const triggerId = await createTrigger('Nightly');
    const nonce = armingNonceFor(triggerId);
    await arm(triggerId, nonce);
    await api(`/api/triggers/${triggerId}/disarm`, { method: 'POST' });

    const replayed = await arm(triggerId, nonce);

    expect(replayed.status).toBe(401);
    expect(await armedAtOf(triggerId)).toBeNull();
  });

  it('refuses a nonce minted for setting a secret, even named after the trigger', async () => {
    const triggerId = await createTrigger('Nightly');
    const nonceToSetASecret = parent.mintOperatorNonce({ action: 'set', scope: { kind: 'trigger', id: triggerId }, name: triggerId });

    const response = await arm(triggerId, nonceToSetASecret);

    expect(response.status).toBe(401);
    expect(await armedAtOf(triggerId)).toBeNull();
  });

  it('refuses an arming without a proof, and a proof nobody minted', async () => {
    const triggerId = await createTrigger('Nightly');

    const withoutProof = await arm(triggerId);
    const withInventedProof = await arm(triggerId, 'invented-proof-of-a-human-gesture');

    expect([withoutProof.status, withInventedProof.status]).toEqual([401, 401]);
    expect(await armedAtOf(triggerId)).toBeNull();
  });
});

describe('a daemon started without the desktop app', () => {
  it('arms nothing: no nonce can exist', async () => {
    const standalone = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-arming-standalone-'), OPENFLEET_PORT: '0' });
    const standaloneDaemon = await startDaemon(standalone);
    standaloneDaemon.db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Arming', 'now')").run(PROJECT_ID);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${standalone.adminToken}` };
    const created = await fetch(`${standaloneDaemon.server.url}/api/triggers`, { method: 'POST', headers, body: JSON.stringify({ projectId: PROJECT_ID, ownerManagerId: null, title: 'Nightly' }) });
    const { id } = (await created.json()) as { id: string };

    const response = await fetch(`${standaloneDaemon.server.url}/api/triggers/${id}/arm`, { method: 'POST', headers: { ...headers, [HUMAN_PROOF_HEADER]: 'any-proof-at-all' }, body: JSON.stringify({ approvedRev: 1 }) });
    await standaloneDaemon.close();

    expect(response.status).toBe(401);
  });
});
