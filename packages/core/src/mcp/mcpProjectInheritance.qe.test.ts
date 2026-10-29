import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const OWN_PROJECT_ID = randomUUID();
const OTHER_PROJECT_ID = randomUUID();
const STORE_OF_OWN_PROJECT = 'store-own';
const STORE_OF_OTHER_PROJECT = 'store-other';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;

let daemon: Daemon;
let adminToken: string;
let home: string;
let worktreesRoot: string;
let clients: Client[];
const directories = createTempDirTracker();

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const tokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const projectIdOf = (sessionId: string) => (daemon.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null }).project_id;

const adminApi = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...options.headers },
});

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'inheritance', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenOf(sessionId)}` } } }));
  return client;
}

async function aRootSession({ projectId }: { projectId?: string }): Promise<string> {
  // A project root works in the worktrees root, so every child directory made below it belongs to the project.
  const directory = projectId ? worktreesRoot : directories.make('root-session-');
  const body = { directory, name: 'Root', harness: 'fake', emoji: '🤖', ...(projectId && { projectId }) };
  const response = await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  return ((await response.json()) as { id: string }).id;
}

async function spawn(parent: Client, extra: Record<string, unknown> = {}): Promise<{ id: string }> {
  const directory = join(worktreesRoot, `child-${randomUUID()}`);
  mkdirSync(directory);
  const result = await parent.callTool({ name: 'create_session', arguments: { directory, name: 'Spawned', ...extra } });
  return JSON.parse(textOf(result)) as { id: string };
}

const spawnManager = (parent: Client, extra: Record<string, unknown> = {}) =>
  spawn(parent, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 }, ...extra });

async function aNoteOf(projectId: string, title: string): Promise<string> {
  const response = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId, title, bodyMd: `body of ${title}` }) });
  const created = (await response.json()) as { id?: string; data?: { id: string } };
  return (created.id ?? created.data!.id);
}

beforeEach(async () => {
  clients = [];
  home = directories.make('project-inheritance-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
  daemon.db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('${OWN_PROJECT_ID}', 'Own', 'now'), ('${OTHER_PROJECT_ID}', 'Other', 'now')`);
  const insertStore = daemon.db.prepare("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES (?, ?, ?, 'now', 'now')");
  insertStore.run(STORE_OF_OWN_PROJECT, OWN_PROJECT_ID, 'Own log');
  insertStore.run(STORE_OF_OTHER_PROJECT, OTHER_PROJECT_ID, 'Foreign log');
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('a session created through MCP create_session', () => {
  it('belongs to the project of its parent', async () => {
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));

    const child = await spawn(parent);

    expect(projectIdOf(child.id)).toBe(OWN_PROJECT_ID);
  });

  it('has no project when its parent has none', async () => {
    const parent = await connect(await aRootSession({}));

    const child = await spawn(parent);

    expect(projectIdOf(child.id)).toBeNull();
  });

  it('does not offer a project field in the create_session input schema', async () => {
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));

    const createSession = (await parent.listTools()).tools.find((tool) => tool.name === 'create_session')!;

    expect(Object.keys(createSession.inputSchema.properties ?? {})).not.toContain('projectId');
    expect(Object.keys(createSession.inputSchema.properties ?? {})).not.toContain('project_id');
  });

  it('ignores a project another than its parent\'s that the caller tries to impose', async () => {
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));

    const child = await spawn(parent, { projectId: OTHER_PROJECT_ID, project_id: OTHER_PROJECT_ID });

    expect(projectIdOf(child.id)).toBe(OWN_PROJECT_ID);
  });

  it('keeps no project for a parentless-project caller that tries to impose one', async () => {
    const parent = await connect(await aRootSession({}));

    const child = await spawn(parent, { projectId: OTHER_PROJECT_ID, project_id: OTHER_PROJECT_ID });

    expect(projectIdOf(child.id)).toBeNull();
  });

  it('sees the notes of its parent\'s project and not those of another project', async () => {
    const ownNoteId = await aNoteOf(OWN_PROJECT_ID, 'Own note');
    const foreignNoteId = await aNoteOf(OTHER_PROJECT_ID, 'Foreign note');
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));
    const child = await connect((await spawn(parent)).id);

    const own = await child.callTool({ name: 'get_note', arguments: { note: ownNoteId } });
    const foreign = await child.callTool({ name: 'get_note', arguments: { note: foreignNoteId } });

    expect(own.isError).not.toBe(true);
    expect(foreign.isError).toBe(true);
  });

  it('sees the tables of its parent\'s project and not those of another project', async () => {
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));
    const child = await connect((await spawn(parent)).id);

    const own = await child.callTool({ name: 'describe_data_store', arguments: { store: STORE_OF_OWN_PROJECT } });
    const foreign = await child.callTool({ name: 'describe_data_store', arguments: { store: STORE_OF_OTHER_PROJECT } });

    expect(own.isError).not.toBe(true);
    expect(foreign.isError).toBe(true);
  });
});

describe('a manager created through MCP create_session', () => {
  it('belongs to the project of its parent', async () => {
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));

    const manager = await spawnManager(parent);

    expect(projectIdOf(manager.id)).toBe(OWN_PROJECT_ID);
  });

  it('links a mission note of its project and refuses one of another project', async () => {
    const ownNoteId = await aNoteOf(OWN_PROJECT_ID, 'Mission');
    const foreignNoteId = await aNoteOf(OTHER_PROJECT_ID, 'Foreign mission');
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));
    const manager = await spawnManager(parent);

    const own = await adminApi(`/api/managers/${manager.id}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId: ownNoteId }) });
    const foreign = await adminApi(`/api/managers/${manager.id}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId: foreignNoteId }) });

    expect([own.status, foreign.status]).toEqual([200, 404]);
  });

  it('binds a log table of its project and refuses one of another project', async () => {
    const parent = await connect(await aRootSession({ projectId: OWN_PROJECT_ID }));
    const manager = await connect((await spawnManager(parent)).id);

    const own = await manager.callTool({ name: 'set_argus_log_store', arguments: { store_id: STORE_OF_OWN_PROJECT } });
    const foreign = await manager.callTool({ name: 'set_argus_log_store', arguments: { store_id: STORE_OF_OTHER_PROJECT } });

    expect(own.isError).not.toBe(true);
    expect(foreign.isError).toBe(true);
  });

  it('has no project when its parent has none', async () => {
    const parent = await connect(await aRootSession({}));

    const manager = await spawnManager(parent);

    expect(projectIdOf(manager.id)).toBeNull();
  });
});
