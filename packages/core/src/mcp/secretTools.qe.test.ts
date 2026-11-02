import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON, OPERATOR_NONCE_HEADER, type SecretScope } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { defaultCommandPolicySettings } from '../policy/commandPolicySettings.js';
import { ARBITER_TOOL_NAMES } from './arbiterTools.js';
import { createFakeTauriParent, type FakeTauriParent } from '../secrets/fakeTauriParent.testkit.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
const playbook: SecretScope = { kind: 'playbook', id: 'pb-1' };
const SECRET_NAME = 'JIRA_TOKEN';

let daemon: Daemon;
let config: Config;
let parent: FakeTauriParent;
let store: InMemorySecretStore;

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers as Record<string, string> | undefined) } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(textOf(result));

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'qe', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

const makeDirectory = (name: string) => {
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

const bootRootSession = async () => {
  mkdirSync(config.worktreesRoot, { recursive: true });
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: config.worktreesRoot, name: 'Root', harness: 'fake', emoji: '🧭' }) })).json()) as { id: string };
  return created.id;
};

const setSecretAsHuman = (value: string) =>
  adminApi(`/api/secrets/playbook/pb-1/${SECRET_NAME}`, { method: 'PUT', headers: { [OPERATOR_NONCE_HEADER]: parent.mintOperatorNonce() }, body: JSON.stringify({ value }) });

beforeEach(async () => {
  store = createInMemorySecretStore();
  parent = createFakeTauriParent();
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-secret-tools-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const settings = defaultCommandPolicySettings();
  daemon = await startDaemon(config, { secrets: { store, parent: parent.link }, commandPolicy: { settings: { ...settings, unattended: { ...settings.unattended, askBecomesDeny: false } } } });
  daemon.db.prepare("INSERT INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES (?, 'playbook', 'pb-1', ?, 'missing')").run(randomUUID(), SECRET_NAME);
});
afterEach(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('the secret tools of a manager', () => {
  it('lists the declared secrets as stored or missing, and nothing else', async () => {
    const manager = await connectAs(await bootRootSession());
    const before = parsed(await manager.callTool({ name: 'list_playbook_secret_statuses', arguments: { playbook_id: 'pb-1' } }));
    const value = ['canary', randomUUID()].join('-');
    await setSecretAsHuman(value);

    const after = parsed(await manager.callTool({ name: 'list_playbook_secret_statuses', arguments: { playbook_id: 'pb-1' } }));

    expect(before).toEqual({ playbook_id: 'pb-1', statuses: [{ name: SECRET_NAME, status: 'missing' }] });
    expect(after).toEqual({ playbook_id: 'pb-1', statuses: [{ name: SECRET_NAME, status: 'stored' }] });
    expect(JSON.stringify(after).includes(value)).toBe(false);
  });

  it('clears a secret, twice without complaint, and the value leaves the store', async () => {
    const manager = await connectAs(await bootRootSession());
    await setSecretAsHuman(['canary', randomUUID()].join('-'));

    const first = parsed(await manager.callTool({ name: 'clear_playbook_secret', arguments: { playbook_id: 'pb-1', name: SECRET_NAME } }));
    const second = parsed(await manager.callTool({ name: 'clear_playbook_secret', arguments: { playbook_id: 'pb-1', name: SECRET_NAME } }));

    expect([first.status, second.status, store.valueOf(playbook, SECRET_NAME)]).toEqual(['missing', 'missing', undefined]);
  });

  it('answers a playbook no secret is declared under with secret_scope_not_found', async () => {
    const manager = await connectAs(await bootRootSession());

    const result = await manager.callTool({ name: 'list_playbook_secret_statuses', arguments: { playbook_id: 'no-such-playbook' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('secret_scope_not_found');
  });

  it('offers no tool that sets a secret: the only two secret tools are the status list and the clear', async () => {
    const manager = await connectAs(await bootRootSession());

    const names = (await manager.listTools()).tools.map((tool) => tool.name).filter((name) => /secret/.test(name));

    expect(names.sort()).toEqual(['clear_playbook_secret', 'list_playbook_secret_statuses']);
  });

  it('hides both tools from a reviewer', async () => {
    const manager = await connectAs(await bootRootSession());
    const created = parsed(await manager.callTool({ name: 'create_session', arguments: { directory: makeDirectory('reviewer'), name: 'Reviewer', role: 'reviewer' } }));
    const reviewer = await connectAs(created.id);

    const names = (await reviewer.listTools()).tools.map((tool) => tool.name);

    expect(names.filter((name) => /secret/.test(name))).toEqual([]);
  });

  it('keeps both tools out of the fixed tool set of an arbiter', () => {
    expect([...ARBITER_TOOL_NAMES].filter((name) => /secret/.test(name))).toEqual([]);
  });
});

describe('what the activity log keeps of a secret tool call', () => {
  it('holds no free text from the arguments, the result or the error, whatever canary the caller puts in them', async () => {
    const manager = await connectAs(await bootRootSession());
    const canaryName = `canary_${randomUUID().replaceAll('-', '_')}`;
    const canaryValue = ['canary', randomUUID()].join('-');
    await setSecretAsHuman(canaryValue);

    await manager.callTool({ name: 'clear_playbook_secret', arguments: { playbook_id: 'pb-1', name: canaryName, value: canaryValue } });
    await manager.callTool({ name: 'clear_playbook_secret', arguments: { playbook_id: 'pb-1', name: SECRET_NAME, value: canaryValue } });
    await manager.callTool({ name: 'list_playbook_secret_statuses', arguments: { playbook_id: 'pb-1', value: canaryValue } });
    const activity = await (await adminApi('/api/activity?limit=200')).text();

    expect([activity.includes(canaryValue), activity.includes(canaryName)]).toEqual([false, false]);
    expect(activity).toContain('clear_playbook_secret');
  });
});
