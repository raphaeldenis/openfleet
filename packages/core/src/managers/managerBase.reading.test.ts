import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { loadManagerBase } from './managerBase.js';

const SESSION_START_SOURCES = ['startup', 'compact', 'clear', 'resume'] as const;
const SHA_PREFIX_LENGTH = 8;

const tempDirs = createTempDirTracker();
const shippedBase = loadManagerBase();
const shaPrefix = shippedBase.sha.slice(0, SHA_PREFIX_LENGTH);

let config: Config;
let daemon: Daemon;
const openClients: Client[] = [];

interface SpawnAnswer { id: string; warnings?: { code: string; message: string; hint?: string }[] }
interface BaseRead { version: number; sha: string; readAt: string }

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (body: Record<string, unknown>) =>
  (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', ...body }) })).json()) as { id: string };
const aManager = (name: string) => createSession({ name, manager: { pulseSeconds: 3600, childrenCap: 5, mission: 'Ship the fleet' } });
const mcpClientOf = async (sessionId: string): Promise<Client> => {
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
  const client = new Client({ name: 'base-reading', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  openClients.push(client);
  return client;
};
const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const readWholeBase = (client: Client) => callTool(client, 'get_manager_base');
const readOneSection = (client: Client) => callTool(client, 'get_manager_base', { section: '§5' });
const profileOf = async (managerId: string) => (await (await api(`/api/managers/${managerId}`)).json()) as { manager: { baseRead?: BaseRead; baseVersion?: number } };
const spawnChild = async (client: Client, name: string): Promise<{ isError?: boolean; answer: SpawnAnswer; text: string }> => {
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  const result = await callTool(client, 'create_session', { directory, name });
  const text = textOf(result);
  return { isError: result.isError as boolean | undefined, text, answer: result.isError ? ({ id: '' } as SpawnAnswer) : (JSON.parse(text) as SpawnAnswer) };
};
const hookTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const contextOfSessionStart = async (sessionId: string, source: string): Promise<string> => {
  const response = await fetch(`${daemon.server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart', source }),
  });
  const answer = (await response.json()) as { hookSpecificOutput?: { additionalContext: string } };
  return answer.hookSpecificOutput?.additionalContext ?? '';
};
const fakeHarness = () => daemon.harnesses.find((harness): harness is FakeHarness => harness instanceof FakeHarness)!;

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-base-reading-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await daemon.close();
  tempDirs.removeAll();
});

describe('the read tracking of the manager base', () => {
  it('shows a manager that never read the base as not having read it, with the current version', async () => {
    const manager = await aManager('Fresh');

    const { manager: view } = await profileOf(manager.id);

    expect(view.baseRead).toBeUndefined();
    expect(view.baseVersion).toBe(shippedBase.version);
  });

  it('records the version, the sha and the date when the whole base is read', async () => {
    const manager = await aManager('Reader');
    const client = await mcpClientOf(manager.id);
    const beforeRead = Date.now();

    await readWholeBase(client);

    const { baseRead } = (await profileOf(manager.id)).manager;
    expect(baseRead).toMatchObject({ version: shippedBase.version, sha: shippedBase.sha });
    expect(Date.parse(baseRead!.readAt)).toBeGreaterThanOrEqual(beforeRead - 1000);
  });

  it('does not count a read of one section', async () => {
    const manager = await aManager('Skimmer');
    const client = await mcpClientOf(manager.id);

    await readOneSection(client);

    expect((await profileOf(manager.id)).manager.baseRead).toBeUndefined();
  });

  it('keeps the earlier whole read when a section is read afterwards', async () => {
    const manager = await aManager('Rereader');
    const client = await mcpClientOf(manager.id);
    await readWholeBase(client);
    const { baseRead: firstRead } = (await profileOf(manager.id)).manager;

    await readOneSection(client);

    expect((await profileOf(manager.id)).manager.baseRead).toEqual(firstRead);
  });

  it('records nothing for a refused read of a session that is not a manager', async () => {
    const plain = await createSession({ name: 'Plain' });
    const client = await mcpClientOf(plain.id);

    const result = await readWholeBase(client);

    expect(result.isError).toBe(true);
    expect(daemon.db.prepare('SELECT COUNT(*) AS count FROM managers WHERE session_id = ?').get(plain.id)).toEqual({ count: 0 });
  });

  it('tells the manager in get_argus_status what it read', async () => {
    const manager = await aManager('Informed');
    const client = await mcpClientOf(manager.id);
    await readWholeBase(client);

    const status = JSON.parse(textOf(await callTool(client, 'get_argus_status'))) as { manager: { baseRead?: BaseRead; baseVersion?: number } };

    expect(status.manager.baseRead).toMatchObject({ version: shippedBase.version, sha: shippedBase.sha });
    expect(status.manager.baseVersion).toBe(shippedBase.version);
  });
});

describe('the base block of the SessionStart context of a manager', () => {
  it.each(SESSION_START_SOURCES)('names the base version and sha on %s', async (source) => {
    const manager = await aManager(`Starter-${source}`);

    const context = await contextOfSessionStart(manager.id, source);

    expect(context).toContain(`Base v${shippedBase.version}`);
    expect(context).toContain(shaPrefix);
    expect(context).toContain('get_manager_base');
  });

  it('gives a session that is no manager no base block', async () => {
    const plain = await createSession({ name: 'Plain-start' });

    const context = await contextOfSessionStart(plain.id, 'compact');

    expect(context).not.toContain('Base v');
  });
});

describe('the pulse text of a manager', () => {
  it('carries the base version and sha', async () => {
    const manager = await aManager('Pulsed');
    await contextOfSessionStart(manager.id, 'startup');

    const response = await api(`/api/managers/${manager.id}/pulse`, { method: 'POST' });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      const pulseWritten = fakeHarness().handles.flatMap((handle) => handle.written).find((entry) => entry.startsWith('[pulse]') && entry.includes('Base v'));
      expect(pulseWritten).toContain(`Base v${shippedBase.version} (${shaPrefix})`);
    }, { timeout: 5000, interval: 50 });
  });
});

describe('the base_not_read guard on spawning a child (refuses by default)', () => {
  const childCountOf = (managerId: string) => (daemon.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ?').get(managerId) as { count: number }).count;

  it('refuses a manager that never read the base, tells it to read it with get_manager_base, and creates no child', async () => {
    const manager = await aManager('Unread-spawner');
    const client = await mcpClientOf(manager.id);

    const { isError, text } = await spawnChild(client, 'unread-child-a');

    expect(isError).toBe(true);
    expect(text).toContain('base_not_read');
    expect(text).toContain('get_manager_base');
    expect(childCountOf(manager.id)).toBe(0);
  });

  it('refuses a manager that only skimmed one section', async () => {
    const manager = await aManager('Skimmer-spawner');
    const client = await mcpClientOf(manager.id);
    await readOneSection(client);

    const { isError, text } = await spawnChild(client, 'skimmed-child');

    expect(isError).toBe(true);
    expect(text).toContain('base_not_read');
  });

  it('spawns without a warning once the whole base is read', async () => {
    const manager = await aManager('Read-spawner');
    const client = await mcpClientOf(manager.id);
    await readWholeBase(client);

    const { isError, answer } = await spawnChild(client, 'read-child');

    expect(isError).toBeUndefined();
    expect(answer.warnings).toBeUndefined();
  });

  it('refuses a manager whose read base is an older version, and creates no child', async () => {
    const manager = await aManager('Outdated-spawner');
    const client = await mcpClientOf(manager.id);
    await readWholeBase(client);
    daemon.db.prepare('UPDATE managers SET base_version_read = ?, base_sha_read = ? WHERE session_id = ?').run(shippedBase.version - 1, 'f'.repeat(64), manager.id);

    const { isError, text } = await spawnChild(client, 'outdated-child');

    expect(isError).toBe(true);
    expect(text).toContain('base_not_read');
    expect(childCountOf(manager.id)).toBe(0);
  });

  it('gives a child spawned by a root session that is no manager no warning', async () => {
    const root = await createSession({ name: 'Root' });
    const client = await mcpClientOf(root.id);

    const { answer } = await spawnChild(client, 'root-child');

    expect(answer.warnings).toBeUndefined();
  });
});
