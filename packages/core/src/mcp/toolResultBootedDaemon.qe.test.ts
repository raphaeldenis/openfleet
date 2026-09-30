import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const rawText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));
const keysOf = (value: object) => Object.keys(value).sort();

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'qe', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

const childDirectory = (name: string) => {
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

async function bootRootSession() {
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Root', harness: 'fake', emoji: '🧭' }) })).json()) as { id: string };
  new ProjectRepository(daemon.db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', created.id);
  return created.id;
}

beforeEach(async () => {
  const home = tempDirs.make('of-qe-token01-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

describe('QE — a booted daemon serves compact MCP results on the real route', () => {
  it('session family: create_session keeps what a manager needs to message the child, and lifecycle fields survive on a closed child', async () => {
    const rootId = await bootRootSession();
    const root = await connectAs(rootId);

    const created = parsed(await root.callTool({ name: 'create_session', arguments: { directory: childDirectory('kid'), name: 'Kid', emoji: '🛠️', model: 'sonnet', role: 'reviewer' } }));
    const messaged = await root.callTool({ name: 'send_session_message', arguments: { target_uuid: created.id, body: 'hello' } });
    await root.callTool({ name: 'close_session', arguments: { session_id: created.id } });
    const status = parsed(await root.callTool({ name: 'get_session_status', arguments: { session_id: created.id } }));

    expect(messaged.isError).toBeFalsy();
    expect(created).toMatchObject({ name: 'Kid', emoji: '🛠️', state: 'starting', role: 'reviewer' });
    expect(created.model).toBe('sonnet');
    expect(status).toMatchObject({ id: created.id, state: 'closed', role: 'reviewer' });
    expect(status.closedAt).toEqual(expect.any(String));
    expect(status).toHaveProperty('exitCode');
  });

  it('session family: list_sessions gives grandchildren their parentId and list_children omits it', async () => {
    const rootId = await bootRootSession();
    const root = await connectAs(rootId);
    const child = parsed(await root.callTool({ name: 'create_session', arguments: { directory: childDirectory('a'), name: 'A' } }));
    const childClient = await connectAs(child.id);
    const grandchild = parsed(await childClient.callTool({ name: 'create_session', arguments: { directory: childDirectory('b'), name: 'B' } }));

    const listed = parsed(await root.callTool({ name: 'list_sessions', arguments: {} }));
    const children = parsed(await root.callTool({ name: 'list_children', arguments: {} }));

    const byId = Object.fromEntries(listed.map((s: { id: string }) => [s.id, s]));
    expect(byId[grandchild.id].parentId).toBe(child.id);
    expect(byId[child.id].parentId).toBe(rootId);
    expect(children.map((s: { id: string }) => s.id)).toEqual([child.id]);
  });

  it('fleet status: a manager reads its own record without its session id, and a child pending permission keeps toolName and ageSeconds', async () => {
    const rootId = await bootRootSession();
    const root = await connectAs(rootId);
    const lead = parsed(await root.callTool({ name: 'create_session', arguments: { directory: childDirectory('lead'), name: 'Lead', manager: { pulse_seconds: 3600, children_cap: 2, mission: 'm' } } }));
    const leadClient = await connectAs(lead.id);
    const child = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: childDirectory('worker'), name: 'Worker' } }));
    const childHookToken = (daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(child.id) as { hook_token: string }).hook_token;
    const hook = (body: object) => fetch(`${daemon.server.url}/hooks/${childHookToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
    await hook({ hook_event_name: 'SessionStart' });
    const pendingDecision = hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });

    let status: { manager: Record<string, unknown> | null; children: Record<string, unknown>[] } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = parsed(await leadClient.callTool({ name: 'get_argus_status', arguments: {} }));
      if (status!.children[0]?.pendingPermission) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(status!.manager).not.toBeNull();
    expect(status!.manager).not.toHaveProperty('sessionId');
    expect(status!.children[0]!.pendingPermission).toMatchObject({ toolName: 'Bash', ageSeconds: expect.any(Number) });
    void pendingDecision;
  });

  it('note family: chained acks carry rev, get_note has both shapes, stale conflict text keeps the current rev', async () => {
    const rootId = await bootRootSession();
    const root = await connectAs(rootId);

    const created = parsed(await root.callTool({ name: 'create_note', arguments: { title: 'N', body_md: '## H\nx' } }));
    const second = parsed(await root.callTool({ name: 'update_note', arguments: { note: created.id, body_md: '## H\ny', expected_rev: created.rev } }));
    const third = parsed(await root.callTool({ name: 'update_note', arguments: { note: created.id, body_md: '## H\nz', expected_rev: second.rev } }));
    const stale = await root.callTool({ name: 'update_note', arguments: { note: created.id, body_md: 'q', expected_rev: created.rev } });
    const fetched = parsed(await root.callTool({ name: 'get_note', arguments: { note: created.id } }));

    expect([created.rev, second.rev, third.rev]).toEqual([1, 2, 3]);
    expect(stale.isError).toBe(true);
    expect(rawText(stale)).toBe('409 stale_revision, current rev: 3');
    expect(keysOf(fetched)).toEqual(['bodyMd', 'fileBacked', 'folder', 'id', 'rev', 'shared', 'title']);
  });

  it('table family: create/describe/query/list keep every id an agent needs to chain calls', async () => {
    const rootId = await bootRootSession();
    const root = await connectAs(rootId);

    const store = parsed(await root.callTool({ name: 'create_data_store', arguments: { display_name: 't' } }));
    const column = parsed(await root.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'c', column_type: 'text' } }));
    const inserted = parsed(await root.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [column.id]: 'v' }] } }));
    await root.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: inserted.ids[0], patch: { [column.id]: 'w' } }] } });
    const queried = parsed(await root.callTool({ name: 'query_data_store', arguments: { store: store.id, where: [{ columnId: column.id, op: 'eq', value: 'w' }] } }));
    const described = parsed(await root.callTool({ name: 'describe_data_store', arguments: { store: store.id } }));

    expect(queried.rows[0].id).toBe(inserted.ids[0]);
    expect(queried.rows[0].data[column.id]).toBe('w');
    expect(described.columns[0].id).toBe(column.id);
  });

  it('token-02 probe: on the real route an agent reads the 50x12 table columnar in about a third of the default bytes, and a note with mentions_only without repeating its body', async () => {
    const rootId = await bootRootSession();
    const root = await connectAs(rootId);
    const store = parsed(await root.callTool({ name: 'create_data_store', arguments: { display_name: 'backlog' } }));
    const columnIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const isSelect = index % 4 === 0;
      const column = parsed(await root.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: `column ${index}`, column_type: isSelect ? 'select' : 'text', ...(isSelect ? { options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] } : {}) } }));
      columnIds.push(column.id);
    }
    const rows = Array.from({ length: 50 }, (_, rowIndex) => Object.fromEntries(columnIds.map((id, index) => [id, index % 4 === 0 ? 'todo' : `value ${rowIndex}-${index}`])));
    await root.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows } });
    const target = parsed(await root.callTool({ name: 'create_note', arguments: { title: 'Target', body_md: 'target body', shared: true } }));
    const source = parsed(await root.callTool({ name: 'create_note', arguments: { title: 'Source', body_md: `see @note:${target.id}` } }));

    const defaultResult = await root.callTool({ name: 'query_data_store', arguments: { store: store.id, limit: 50 } });
    const columnarResult = await root.callTool({ name: 'query_data_store', arguments: { store: store.id, limit: 50, format: 'columnar' } });
    const expandedNote = await root.callTool({ name: 'get_note', arguments: { note: source.id } });
    const mentionsOnlyNote = await root.callTool({ name: 'get_note', arguments: { note: source.id, mentions_only: true } });

    const bytes = (result: unknown) => Buffer.byteLength(rawText(result), 'utf8');
    expect(bytes(defaultResult)).toBe(35049);
    expect(bytes(columnarResult)).toBe(11007);
    expect(parsed(columnarResult).count).toBe(50);
    expect(bytes(columnarResult)).toBeLessThan(bytes(defaultResult) / 2);
    expect(parsed(mentionsOnlyNote).mentionBlocks).toHaveLength(1);
    expect(parsed(mentionsOnlyNote)).not.toHaveProperty('expandedBody');
    expect(bytes(mentionsOnlyNote)).toBeLessThan(bytes(expandedNote));
  });

  it('REST keeps its full note shape while MCP is compact: an operator reading a note over HTTP still gets projectId, createdAt, updatedAt and docsRelativePath', async () => {
    await bootRootSession();
    const created = (await (await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: 'p1', title: 'R', bodyMd: 'b' }) })).json()) as { data?: { id: string } } & { id?: string };
    const noteId = created.data?.id ?? created.id!;

    const fetched = await (await adminApi(`/api/notes/${noteId}?projectId=p1`)).json();
    const note = (fetched as { data?: object }).data ?? fetched;

    expect(keysOf(note)).toEqual(['bodyMd', 'createdAt', 'docsRelativePath', 'fileBacked', 'folder', 'id', 'projectId', 'rev', 'shared', 'title', 'updatedAt']);
  });

  it('REST keeps its full session shape while MCP is compact: an operator reading a session over HTTP still gets harness, createdAt and permissionMode', async () => {
    const root = await connectAs(await bootRootSession());
    await root.callTool({ name: 'create_session', arguments: { directory: childDirectory('kid'), name: 'Kid' } });

    const sessions = (await (await adminApi('/api/sessions')).json()) as { name: string }[];

    expect(keysOf(sessions.find((session) => session.name === 'Kid')!)).toEqual(['createdAt', 'directory', 'emoji', 'harness', 'id', 'name', 'parentId', 'permissionMode', 'state', 'stateSince']);
  });

  it('REST keeps its full row and row history shapes while MCP is compact: an operator still gets storeId and createdAt on rows, and rowId and id on changes', async () => {
    const root = await connectAs(await bootRootSession());
    const store = parsed(await root.callTool({ name: 'create_data_store', arguments: { display_name: 'T' } }));
    const column = parsed(await root.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'c', column_type: 'text' } }));
    const inserted = parsed(await root.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [column.id]: 'v' }] } }));

    const rows = (await (await adminApi(`/api/data-stores/${store.id}/rows?projectId=p1`)).json()) as { items: object[] };
    const changes = (await (await adminApi(`/api/data-stores/${store.id}/rows/${inserted.ids[0]}/changes?projectId=p1`)).json()) as { items: object[] };

    expect(keysOf(rows.items[0]!)).toEqual(['createdAt', 'data', 'id', 'storeId', 'updatedAt']);
    expect(keysOf(changes.items[0]!)).toEqual(['actorKind', 'actorLabel', 'change', 'createdAt', 'id', 'rowId']);
  });
});
