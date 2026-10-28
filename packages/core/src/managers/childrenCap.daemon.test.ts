import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
const openClients: Client[] = [];

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;

interface ManagerStatus { childrenCap: number; childrenCount: number; childrenHeadroom: number }

let config: Config;
let daemon: Daemon;
let spawnedChildCount = 0;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });

const createManagerWithCap = (childrenCap: number) =>
  api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name: `Cap ${childrenCap}`, manager: { pulseSeconds: 3600, childrenCap, mission: 'Ship the fleet' } }) });

const aManagerWithCap = async (childrenCap: number) => {
  const created = await createManagerWithCap(childrenCap);
  const { id } = (await created.json()) as { id: string };
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string };
  const client = new Client({ name: 'children-cap', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  openClients.push(client);
  await client.callTool({ name: 'get_manager_base', arguments: {} });
  return { id, client };
};

const spawnChild = async (client: Client) => {
  spawnedChildCount += 1;
  const name = `cap-child-${spawnedChildCount}`;
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  const result = await client.callTool({ name: 'create_session', arguments: { directory, name } });
  const text = textOf(result);
  return { isError: result.isError === true, text, childId: result.isError ? '' : (JSON.parse(text) as { id: string }).id };
};

const closeChild = (client: Client, childId: string) => client.callTool({ name: 'close_session', arguments: { session_id: childId } });
const patchCap = (managerId: string, childrenCap: number) => api(`/api/managers/${managerId}`, { method: 'PATCH', body: JSON.stringify({ childrenCap }) });
const statusSeenByManager = async (client: Client) => (JSON.parse(textOf(await client.callTool({ name: 'get_argus_status', arguments: {} }))) as { manager: ManagerStatus }).manager;
const liveChildrenCountOf = (managerId: string) => (daemon.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ? AND state <> 'closed'").get(managerId) as { count: number }).count;

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-children-cap-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config, {});
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await daemon.close();
  tempDirs.removeAll();
});

describe('the children cap given when a manager is created through the API', () => {
  it.each([
    { childrenCap: 0, violatedBound: '>=1' },
    { childrenCap: 65, violatedBound: '<=64' },
  ])('refuses a cap of $childrenCap, naming the field and the bound $violatedBound', async ({ childrenCap, violatedBound }) => {
    const response = await createManagerWithCap(childrenCap);

    const message = await response.text();
    expect(response.status).toBe(400);
    expect(message).toContain('childrenCap');
    expect(message).toContain(violatedBound);
  });

  it.each([1, 64])('accepts a cap of %s and shows it to the manager', async (childrenCap) => {
    const { client } = await aManagerWithCap(childrenCap);

    const status = await statusSeenByManager(client);

    expect(status).toMatchObject({ childrenCap, childrenCount: 0, childrenHeadroom: childrenCap });
  });

  it('refuses to lower the cap of an existing manager to 0 and keeps the stored cap', async () => {
    const { id, client } = await aManagerWithCap(3);

    const response = await patchCap(id, 0);

    expect(response.status).toBe(400);
    expect((await statusSeenByManager(client)).childrenCap).toBe(3);
  });
});

describe('spawning children against the cap', () => {
  it('refuses the child after the cap with children_cap and the live count, then accepts it again once a child is closed', async () => {
    const { id, client } = await aManagerWithCap(2);
    const firstChild = await spawnChild(client);
    const secondChild = await spawnChild(client);

    const refusedChild = await spawnChild(client);
    await closeChild(client, firstChild.childId);
    const childAfterClosing = await spawnChild(client);
    const childRefusedAgain = await spawnChild(client);

    expect([firstChild.isError, secondChild.isError]).toEqual([false, false]);
    expect(refusedChild.isError).toBe(true);
    expect(refusedChild.text).toContain('children_cap');
    expect(refusedChild.text).toContain('children cap reached (2/2)');
    expect(childAfterClosing.isError).toBe(false);
    expect(childRefusedAgain.text).toContain('children cap reached (2/2)');
    expect(liveChildrenCountOf(id)).toBe(2);
  });

  it('refuses the second child under a cap of 1', async () => {
    const { client } = await aManagerWithCap(1);
    await spawnChild(client);

    const refusedChild = await spawnChild(client);

    expect(refusedChild.text).toContain('children cap reached (1/1)');
  });

  it('accepts as many children as a cap of 64 allows, up to the 64th included', async () => {
    const { id, client } = await aManagerWithCap(64);
    for (let index = 0; index < 63; index += 1) await spawnChild(client);

    const lastAllowedChild = await spawnChild(client);
    const firstRefusedChild = await spawnChild(client);

    expect(lastAllowedChild.isError).toBe(false);
    expect(firstRefusedChild.text).toContain('children cap reached (64/64)');
    expect(liveChildrenCountOf(id)).toBe(64);
  }, 60_000);
});

describe('a cap edited through the API', () => {
  it('shows the manager the new cap and the new headroom', async () => {
    const { id, client } = await aManagerWithCap(2);
    await spawnChild(client);

    const raising = await patchCap(id, 5);
    const statusAfterRaising = await statusSeenByManager(client);

    expect(raising.status).toBe(200);
    expect(statusAfterRaising).toMatchObject({ childrenCap: 5, childrenCount: 1, childrenHeadroom: 4 });
  });

  it('lets the manager spawn the child it was refused once the cap is raised', async () => {
    const { id, client } = await aManagerWithCap(1);
    await spawnChild(client);
    const refusedChild = await spawnChild(client);

    await patchCap(id, 2);
    const childAfterRaising = await spawnChild(client);

    expect(refusedChild.text).toContain('children cap reached (1/1)');
    expect(childAfterRaising.isError).toBe(false);
  });

  it('keeps every live child when the cap drops below them, and refuses any new child until enough are closed', async () => {
    const { id, client } = await aManagerWithCap(3);
    const children = [await spawnChild(client), await spawnChild(client), await spawnChild(client)];

    const lowering = await patchCap(id, 1);
    const statusAfterLowering = await statusSeenByManager(client);
    const refusedChild = await spawnChild(client);

    expect(lowering.status).toBe(200);
    expect(statusAfterLowering).toMatchObject({ childrenCap: 1, childrenCount: 3, childrenHeadroom: 0 });
    expect(liveChildrenCountOf(id)).toBe(3);
    expect(refusedChild.text).toContain('children cap reached (3/1)');

    await closeChild(client, children[0]!.childId);
    await closeChild(client, children[1]!.childId);
    const stillRefusedAtCap = await spawnChild(client);
    await closeChild(client, children[2]!.childId);
    const childUnderCap = await spawnChild(client);

    expect(stillRefusedAtCap.text).toContain('children cap reached (1/1)');
    expect(childUnderCap.isError).toBe(false);
  });
});
