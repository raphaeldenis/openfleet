import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon, type DaemonOptions } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { loadManagerBase } from './managerBase.js';

const RESETTING_SOURCES = ['startup', 'compact', 'clear', 'resume'] as const;

const tempDirs = createTempDirTracker();
const shippedBase = loadManagerBase();
const openClients: Client[] = [];

interface SpawnAnswer { id: string; warnings?: { code: string }[] }
interface BaseRead { version: number; sha: string; readAt: string }

interface Rig {
  config: Config;
  daemon: Daemon;
  aManager: (name: string) => Promise<{ id: string }>;
  mcpClientOf: (sessionId: string) => Promise<Client>;
  readWholeBase: (client: Client) => ReturnType<Client['callTool']>;
  spawnChild: (client: Client, name: string) => Promise<{ isError: boolean | undefined; text: string; answer: SpawnAnswer }>;
  sessionStart: (sessionId: string, source: string) => Promise<void>;
  baseReadOf: (managerId: string) => Promise<BaseRead | undefined>;
  bumpTheShippedBase: (managerId: string) => void;
  statusOf: (client: Client) => Promise<{ manager: Record<string, unknown> | null }>;
  patchManager: (managerId: string, body: Record<string, unknown>) => Promise<Response>;
}

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;

async function startRig(options: DaemonOptions): Promise<Rig> {
  const config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-base-guard-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const daemon = await startDaemon(config, options);
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
  const callTool = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return {
    config, daemon,
    aManager: async (name) => (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name, manager: { pulseSeconds: 3600, childrenCap: 5, mission: 'Ship the fleet' } }) })).json()) as { id: string },
    mcpClientOf: async (sessionId) => {
      const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
      const client = new Client({ name: 'base-guard', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
      openClients.push(client);
      return client;
    },
    readWholeBase: (client) => callTool(client, 'get_manager_base'),
    spawnChild: async (client, name) => {
      const directory = join(config.worktreesRoot, name);
      mkdirSync(directory, { recursive: true });
      const result = await callTool(client, 'create_session', { directory, name });
      const text = textOf(result);
      return { isError: result.isError as boolean | undefined, text, answer: result.isError ? { id: '' } : (JSON.parse(text) as SpawnAnswer) };
    },
    sessionStart: async (sessionId, source) => {
      const { hook_token } = daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string };
      await fetch(`${daemon.server.url}/hooks/${hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart', source }) });
    },
    baseReadOf: async (managerId) => ((await (await api(`/api/managers/${managerId}`)).json()) as { manager: { baseRead?: BaseRead } }).manager.baseRead,
    bumpTheShippedBase: (managerId) => {
      daemon.db.prepare('UPDATE managers SET base_version_read = ?, base_sha_read = ? WHERE session_id = ?').run(shippedBase.version - 1, 'f'.repeat(64), managerId);
    },
    statusOf: async (client) => JSON.parse(textOf(await callTool(client, 'get_argus_status'))) as { manager: Record<string, unknown> | null },
    patchManager: (managerId, body) => api(`/api/managers/${managerId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  };
}

const closeRig = async (rig: Rig | undefined) => { await rig?.daemon.close(); };

describe('the SessionStart reset of the manager base read', () => {
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({}); });
  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.close()));
    await closeRig(rig);
    tempDirs.removeAll();
  });

  it.each(RESETTING_SOURCES)('forgets that the whole base was read when the session starts with source %s', async (source) => {
    const manager = await rig.aManager(`Forgetful-${source}`);
    await rig.readWholeBase(await rig.mcpClientOf(manager.id));
    expect(await rig.baseReadOf(manager.id)).toBeDefined();

    await rig.sessionStart(manager.id, source);

    expect(await rig.baseReadOf(manager.id)).toBeUndefined();
  });

  it('shows the manager in get_argus_status that it has not read the base after a reset', async () => {
    const manager = await rig.aManager('Informed-after-reset');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    await rig.sessionStart(manager.id, 'compact');

    const { manager: view } = await rig.statusOf(client);

    expect(view).not.toHaveProperty('baseRead');
  });

  it('keeps the read of a manager when another event than a session start happens', async () => {
    const manager = await rig.aManager('Steady');
    await rig.readWholeBase(await rig.mcpClientOf(manager.id));

    await rig.sessionStart(manager.id, 'unknown-source');

    expect(await rig.baseReadOf(manager.id)).toBeDefined();
  });

  it('lets a manager that reads the whole base again after a reset spawn without a warning', async () => {
    const manager = await rig.aManager('Rereads-after-reset');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    await rig.sessionStart(manager.id, 'clear');
    await rig.readWholeBase(client);

    const { answer } = await rig.spawnChild(client, 'reread-child');

    expect(answer.warnings).toBeUndefined();
  });

  it('warns a manager that spawns after a reset, and still spawns (warn only)', async () => {
    const manager = await rig.aManager('Reset-warned');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    await rig.sessionStart(manager.id, 'compact');

    const { isError, answer } = await rig.spawnChild(client, 'reset-warned-child');

    expect(isError).toBeUndefined();
    expect(answer.warnings?.map((warning) => warning.code)).toEqual(['base_not_read']);
  });

  it('warns a manager that spawns after a version bump, and still spawns (warn only)', async () => {
    const manager = await rig.aManager('Bump-warned');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    rig.bumpTheShippedBase(manager.id);

    const { isError, answer } = await rig.spawnChild(client, 'bump-warned-child');

    expect(isError).toBeUndefined();
    expect(answer.warnings?.map((warning) => warning.code)).toEqual(['base_not_read']);
  });
});

describe('the base_not_read refusal when the enforcement is injected as refuse', () => {
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({ baseNotReadEnforcement: 'refuse' }); });
  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.close()));
    await closeRig(rig);
    tempDirs.removeAll();
  });

  const childCountOf = (managerId: string) => (rig.daemon.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ?').get(managerId) as { count: number }).count;

  it('refuses a fresh manager until it reads the whole base, and creates no child', async () => {
    const manager = await rig.aManager('Refused-fresh');
    const client = await rig.mcpClientOf(manager.id);

    const { isError, text } = await rig.spawnChild(client, 'refused-fresh-child');

    expect(isError).toBe(true);
    expect(text).toContain('base_not_read');
    expect(childCountOf(manager.id)).toBe(0);
  });

  it('accepts the spawn once the whole base is read', async () => {
    const manager = await rig.aManager('Accepted-after-read');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);

    const { isError, answer } = await rig.spawnChild(client, 'accepted-child');

    expect(isError).toBeUndefined();
    expect(answer.id).toBeTruthy();
    expect(answer.warnings).toBeUndefined();
  });

  it('refuses a manager that read only one section', async () => {
    const manager = await rig.aManager('Refused-skimmer');
    const client = await rig.mcpClientOf(manager.id);
    await client.callTool({ name: 'get_manager_base', arguments: { section: '§5' } });

    const { isError, text } = await rig.spawnChild(client, 'skimmer-child');

    expect(isError).toBe(true);
    expect(text).toContain('base_not_read');
  });

  it.each(RESETTING_SOURCES)('refuses again after a SessionStart with source %s, then accepts after a new whole read', async (source) => {
    const manager = await rig.aManager(`Reset-refused-${source}`);
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    expect((await rig.spawnChild(client, `before-${source}`)).isError).toBeUndefined();

    await rig.sessionStart(manager.id, source);
    const afterReset = await rig.spawnChild(client, `after-${source}`);
    await rig.readWholeBase(client);
    const afterReread = await rig.spawnChild(client, `reread-${source}`);

    expect(afterReset.isError).toBe(true);
    expect(afterReset.text).toContain('base_not_read');
    expect(afterReread.isError).toBeUndefined();
  });

  it('refuses again when the shipped base version moves past the one the manager read', async () => {
    const manager = await rig.aManager('Bump-refused');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    rig.bumpTheShippedBase(manager.id);

    const { isError, text } = await rig.spawnChild(client, 'bump-child');

    expect(isError).toBe(true);
    expect(text).toContain('base_not_read');
  });

  it('refuses a read of the same version whose sha differs', async () => {
    const manager = await rig.aManager('Sha-refused');
    const client = await rig.mcpClientOf(manager.id);
    await rig.readWholeBase(client);
    rig.daemon.db.prepare('UPDATE managers SET base_sha_read = ? WHERE session_id = ?').run('e'.repeat(64), manager.id);

    const { isError } = await rig.spawnChild(client, 'sha-child');

    expect(isError).toBe(true);
  });
});

describe('childrenHeadroom in get_argus_status', () => {
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({}); });
  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.close()));
    await closeRig(rig);
    tempDirs.removeAll();
  });

  const spawnMany = async (client: Client, prefix: string, count: number) => {
    for (let index = 0; index < count; index += 1) await rig.spawnChild(client, `${prefix}-${index}`);
  };

  it('is the cap when the manager has no child', async () => {
    const manager = await rig.aManager('Headroom-empty');

    const { manager: view } = await rig.statusOf(await rig.mcpClientOf(manager.id));

    expect(view).toMatchObject({ childrenCap: 5, childrenCount: 0, childrenHeadroom: 5 });
  });

  it('is the cap minus the live children', async () => {
    const manager = await rig.aManager('Headroom-two');
    const client = await rig.mcpClientOf(manager.id);
    await spawnMany(client, 'headroom-two', 2);

    const { manager: view } = await rig.statusOf(client);

    expect(view).toMatchObject({ childrenCap: 5, childrenCount: 2, childrenHeadroom: 3 });
  });

  it('gives a closed child back to the headroom', async () => {
    const manager = await rig.aManager('Headroom-closed');
    const client = await rig.mcpClientOf(manager.id);
    const { answer } = await rig.spawnChild(client, 'headroom-closed-0');
    await client.callTool({ name: 'close_session', arguments: { session_id: answer.id } });

    const { manager: view } = await rig.statusOf(client);

    expect(view).toMatchObject({ childrenCount: 0, childrenHeadroom: 5 });
  });

  it('is never negative when the cap is lowered under the live children; no child is closed and spawns are refused', async () => {
    const manager = await rig.aManager('Headroom-lowered');
    const client = await rig.mcpClientOf(manager.id);
    await spawnMany(client, 'headroom-lowered', 3);

    const patch = await rig.patchManager(manager.id, { childrenCap: 2 });
    const { manager: view } = await rig.statusOf(client);
    const refusedSpawn = await rig.spawnChild(client, 'headroom-lowered-extra');

    expect(patch.status).toBe(200);
    expect(view).toMatchObject({ childrenCap: 2, childrenCount: 3, childrenHeadroom: 0 });
    expect(rig.daemon.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ? AND state <> 'closed'").get(manager.id)).toEqual({ count: 3 });
    expect(refusedSpawn.isError).toBe(true);
    expect(refusedSpawn.text).toContain('children_cap');
  });

  it('is part of the manager profile read over the API', async () => {
    const manager = await rig.aManager('Headroom-api');
    const response = await fetch(`${rig.daemon.server.url}/api/managers/${manager.id}`, { headers: { authorization: `Bearer ${rig.config.adminToken}` } });

    const { manager: view } = (await response.json()) as { manager: { childrenHeadroom?: number } };

    expect(view.childrenHeadroom).toBe(5);
  });
});
