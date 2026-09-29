import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { createMcpHandler } from './mcpServer.js';

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let storeRepo: DataStoreRepository;
let stores: DataStoreService;
let scopedToken: string;
let otherToken: string;
let unscopedToken: string;

/** The daemon has no project-creation UI yet (P3-T02): a session's project comes from a direct row update, the same way seed/test code assigns one. */
function assignProject(sessionId: string, projectId: string): void {
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId);
}

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };

  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  storeRepo = new DataStoreRepository(db);
  let counter = 0;
  stores = new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs }),
  });

  const scoped = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  assignProject(scoped.id, 'p1');
  const other = await sessions.create({ directory: '/tmp', name: 'Legolas', harness: 'fake', emoji: '🏹' });
  assignProject(other.id, 'p2');
  await sessions.create({ directory: '/tmp', name: 'Rootless', harness: 'fake', emoji: '👤' });
  scopedToken = harness.launches[0]!.mcpToken;
  otherToken = harness.launches[1]!.mcpToken;
  unscopedToken = harness.launches[2]!.mcpToken;
});
afterEach(() => {
  vi.restoreAllMocks();
  return server.close();
});

async function createStore(client: Client, displayName = 'backlog') {
  return text(await client.callTool({ name: 'create_data_store', arguments: { display_name: displayName } }));
}

describe('table tools', () => {
  it('lists the table tools', async () => {
    const client = await connect(scopedToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_data_store_column', 'append_to_note', 'close_session', 'create_data_store', 'create_data_store_view', 'create_note', 'create_session',
      'create_worktree', 'delete_data_store_row', 'delete_data_store_view', 'delete_note', 'describe_data_store', 'get_argus_status', 'get_note',
      'get_note_version', 'get_session_status', 'insert_data_store_rows', 'list_children', 'list_data_store_views', 'list_note_versions',
      'list_notes', 'list_row_changes', 'list_sessions', 'message_parent', 'move_note', 'pulse_now', 'query_data_store', 'restore_note_version',
      'search_notes', 'send_session_message', 'update_data_store_rows', 'update_data_store_view', 'update_note', 'update_note_section',
      'update_session',
    ]);
  });

  it('refuses every table tool for a session with no project', async () => {
    const client = await connect(unscopedToken);
    const result = await client.callTool({ name: 'create_data_store', arguments: { display_name: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/no project/i);
  });

  it('surfaces an unexpected error as "request failed" with no internal text, and logs it', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    vi.spyOn(stores, 'query').mockImplementation(() => {
      throw new Error('SELECT secret_column FROM ds_rows');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await client.callTool({ name: 'query_data_store', arguments: { store: store.id } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toBe('request failed');
    expect(logged).toHaveBeenCalled();
  });

  it('create_data_store scopes the new store to the caller\'s own project', async () => {
    const client = await connect(scopedToken);
    const created = await createStore(client);
    expect(created.projectId).toBe('p1');
    expect(created.displayName).toBe('backlog');
  });

  it('describe_data_store returns id, displayName, and columns with id/displayName/columnType/options/sortOrder', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'status', column_type: 'select', options: [{ id: 'todo', label: 'todo' }] } });

    const described = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } }));

    expect(described).toMatchObject({
      id: store.id,
      displayName: 'backlog',
      columns: [{ displayName: 'status', columnType: 'select', options: [{ id: 'todo', label: 'todo' }], sortOrder: 0 }],
    });
    expect(described.columns[0].id).toEqual(expect.any(String));
  });

  it('describe_data_store on another project\'s store fails exactly like a missing store', async () => {
    const owner = await connect(scopedToken);
    const store = await createStore(owner);
    const stranger = await connect(otherToken);

    const strangerResult = await stranger.callTool({ name: 'describe_data_store', arguments: { store: store.id } });
    const missingResult = await stranger.callTool({ name: 'describe_data_store', arguments: { store: 'does-not-exist' } });

    expect(strangerResult.isError).toBe(true);
    expect(missingResult.isError).toBe(true);
    expect((strangerResult.content as { text: string }[])[0]!.text).toBe((missingResult.content as { text: string }[])[0]!.text);
  });

  it('add_data_store_column refuses a bad column definition with a clear, non-throwing error', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    const result = await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'status', column_type: 'select', options: [] } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toBe('A select column needs at least one option, each with an id and a label');
  });

  it('insert_data_store_rows attributes actor_kind: agent with the caller\'s emoji and name', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'title', column_type: 'text' } });
    const columns = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns;
    const titleId = columns[0].id;

    const result = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [titleId]: 'first' }] } }));

    const history = storeRepo.rowHistory(result.ids[0], { projectId: 'p1' });
    expect(history[0]).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli' });
  });

  it('insert_data_store_rows and update_data_store_rows return only the affected row ids and a count, never cell data', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'title', column_type: 'text' } });
    const titleId = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns[0].id;

    const inserted = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [titleId]: 'first' }, { [titleId]: 'second' }] } }));
    expect(inserted).toEqual({ ids: [expect.any(String), expect.any(String)], count: 2 });

    const updated = text(await client.callTool({
      name: 'update_data_store_rows',
      arguments: { store: store.id, updates: inserted.ids.map((row_id: string) => ({ row_id, patch: { [titleId]: 'changed' } })) },
    }));
    expect(updated).toEqual({ ids: inserted.ids, count: 2 });
  });

  it('insert_data_store_rows refuses more than 500 rows in one batch', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    const rows = Array.from({ length: 501 }, () => ({}));
    const result = await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows } });
    expect(result.isError).toBe(true);
  });

  it('insert_data_store_rows is all-or-nothing: one bad row writes nothing', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'title', column_type: 'text' } });

    const result = await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ 'unknown-col': 'x' }, {}] } });

    expect(result.isError).toBe(true);
    const queried = text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id } }));
    expect(queried.rows).toHaveLength(0);
  });

  it('update_data_store_rows writes actor-attributed history for each row and is all-or-nothing on a bad patch', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'status', column_type: 'select', options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] } });
    const statusId = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns[0].id;
    const [row1Id, row2Id] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [statusId]: 'todo' }, { [statusId]: 'todo' }] } })).ids;

    const badBatch = await client.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: row1Id, patch: { [statusId]: 'done' } }, { row_id: row2Id, patch: { [statusId]: 'not-an-option' } }] } });
    expect(badBatch.isError).toBe(true);
    const untouched = text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id } }));
    expect(untouched.rows.find((r: { id: string }) => r.id === row1Id).data[statusId]).toBe('todo');

    const goodBatch = text(await client.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: row1Id, patch: { [statusId]: 'done' } }] } }));
    expect(goodBatch).toEqual({ ids: [row1Id], count: 1 });
    const [latest] = storeRepo.rowHistory(row1Id, { projectId: 'p1' });
    expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { [statusId]: { from: 'todo', to: 'done' } } });
  });

  it('delete_data_store_row writes a delete history entry with its actor and removes the row', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } })).ids;

    const result = await client.callTool({ name: 'delete_data_store_row', arguments: { row_id: rowId } });

    expect(result.isError).toBeFalsy();
    const remaining = text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id } }));
    expect(remaining.rows).toHaveLength(0);
    const history = storeRepo.rowHistory(rowId, { projectId: 'p1' });
    expect(history[0]).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { kind: 'delete' } });
  });

  it('add_data_store_column on another project\'s store fails exactly like a missing store', async () => {
    const owner = await connect(scopedToken);
    const store = await createStore(owner);
    const stranger = await connect(otherToken);

    const strangerResult = await stranger.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'title', column_type: 'text' } });
    const missingResult = await stranger.callTool({ name: 'add_data_store_column', arguments: { store: 'does-not-exist', display_name: 'title', column_type: 'text' } });

    expect(strangerResult.isError).toBe(true);
    expect(missingResult.isError).toBe(true);
    expect((strangerResult.content as { text: string }[])[0]!.text).toBe((missingResult.content as { text: string }[])[0]!.text);
  });

  it('insert_data_store_rows on another project\'s store fails exactly like a missing store', async () => {
    const owner = await connect(scopedToken);
    const store = await createStore(owner);
    const stranger = await connect(otherToken);

    const strangerResult = await stranger.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } });
    const missingResult = await stranger.callTool({ name: 'insert_data_store_rows', arguments: { store: 'does-not-exist', rows: [{}] } });

    expect(strangerResult.isError).toBe(true);
    expect(missingResult.isError).toBe(true);
    expect((strangerResult.content as { text: string }[])[0]!.text).toBe((missingResult.content as { text: string }[])[0]!.text);
  });

  it('update_data_store_rows on another project\'s store fails exactly like a missing store', async () => {
    const owner = await connect(scopedToken);
    const store = await createStore(owner);
    const stranger = await connect(otherToken);

    const strangerResult = await stranger.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: 'r1', patch: {} }] } });
    const missingResult = await stranger.callTool({ name: 'update_data_store_rows', arguments: { store: 'does-not-exist', updates: [{ row_id: 'r1', patch: {} }] } });

    expect(strangerResult.isError).toBe(true);
    expect(missingResult.isError).toBe(true);
    expect((strangerResult.content as { text: string }[])[0]!.text).toBe((missingResult.content as { text: string }[])[0]!.text);
  });

  it('delete_data_store_row on another project\'s row fails exactly like a missing row', async () => {
    const owner = await connect(scopedToken);
    const store = await createStore(owner);
    const [rowId] = text(await owner.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } })).ids;
    const stranger = await connect(otherToken);

    const strangerResult = await stranger.callTool({ name: 'delete_data_store_row', arguments: { row_id: rowId } });
    const missingResult = await stranger.callTool({ name: 'delete_data_store_row', arguments: { row_id: 'does-not-exist' } });

    expect(strangerResult.isError).toBe(true);
    expect(missingResult.isError).toBe(true);
    expect((strangerResult.content as { text: string }[])[0]!.text).toBe((missingResult.content as { text: string }[])[0]!.text);
  });

  it('query_data_store filters, sorts, and limits, defaulting the limit to 100', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'priority', column_type: 'number' } });
    const priorityId = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns[0].id;
    await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [priorityId]: 3 }, { [priorityId]: 1 }, { [priorityId]: 2 }] } });

    const result = text(await client.callTool({
      name: 'query_data_store',
      arguments: { store: store.id, where: [{ columnId: priorityId, op: 'gt', value: 1 }], order_by: [{ columnId: priorityId, dir: 'asc' }], limit: 1 },
    }));

    expect(result.rows.map((r: { data: Record<string, unknown> }) => r.data[priorityId])).toEqual([2]);
    expect(result).toMatchObject({ truncated: false, count: 1 });
  });

  it('query_data_store stops adding rows once the serialized result would exceed 1 MiB and flags truncated', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'blob', column_type: 'text' } });
    const blobId = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns[0].id;
    const bigValue = 'x'.repeat(64 * 1024);
    for (let batch = 0; batch < 5; batch++) {
      const rows = Array.from({ length: 4 }, () => ({ [blobId]: bigValue }));
      await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows } });
    }

    const result = text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id, limit: 20 } }));

    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(result.count);
    expect(result.rows.length).toBeLessThan(20);
  });

  it('query_data_store refuses a limit over 1000', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    const result = await client.callTool({ name: 'query_data_store', arguments: { store: store.id, limit: 1001 } });
    expect(result.isError).toBe(true);
  });

  it('query_data_store on another project\'s store fails exactly like a missing store', async () => {
    const owner = await connect(scopedToken);
    const store = await createStore(owner);
    const stranger = await connect(otherToken);

    const strangerResult = await stranger.callTool({ name: 'query_data_store', arguments: { store: store.id } });
    const missingResult = await stranger.callTool({ name: 'query_data_store', arguments: { store: 'does-not-exist' } });

    expect(strangerResult.isError).toBe(true);
    expect(missingResult.isError).toBe(true);
    expect((strangerResult.content as { text: string }[])[0]!.text).toBe((missingResult.content as { text: string }[])[0]!.text);
  });
});

describe('daemon-set date columns', () => {
  const DAEMON_TIME = '2026-01-01T00:00:00.000Z';
  const FUTURE_TIME = '2031-06-01T00:00:00.000Z';

  async function storeWithColumns(client: Client) {
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'ts', column_type: 'date', auto_value: 'created_at' } });
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'due', column_type: 'date' } });
    const [ts, due] = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns;
    return { storeId: store.id as string, tsId: ts.id as string, dueId: due.id as string };
  }

  it('user can log a row whose time column is stamped by the daemon, whatever the agent sends', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId } = await storeWithColumns(client);

    const inserted = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{ [tsId]: FUTURE_TIME }] } }));

    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data[tsId]).toBe(DAEMON_TIME);
    expect(inserted.ignored).toEqual([tsId]);
  });

  it('user can log a row without naming the time column and gets it stamped, with nothing reported as ignored', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId } = await storeWithColumns(client);

    const inserted = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}] } }));

    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data[tsId]).toBe(DAEMON_TIME);
    expect(inserted).not.toHaveProperty('ignored');
  });

  it('user cannot rewrite the time of a logged row, while an ordinary date column still takes a future date', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId, dueId } = await storeWithColumns(client);
    const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}] } })).ids;

    const refused = await client.callTool({ name: 'update_data_store_rows', arguments: { store: storeId, updates: [{ row_id: rowId, patch: { [tsId]: FUTURE_TIME } }] } });
    const accepted = await client.callTool({ name: 'update_data_store_rows', arguments: { store: storeId, updates: [{ row_id: rowId, patch: { [dueId]: FUTURE_TIME } }] } });

    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0]!.text).toMatch(/set by the daemon/i);
    expect(accepted.isError).toBeFalsy();
    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data).toEqual({ [tsId]: DAEMON_TIME, [dueId]: FUTURE_TIME });
  });

  it('user cannot make a text column daemon-set', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);

    const result = await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'note', column_type: 'text', auto_value: 'created_at' } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/only a date column/i);
  });

  it('describe_data_store tells which column the daemon sets', async () => {
    const client = await connect(scopedToken);
    const { storeId } = await storeWithColumns(client);

    const { columns } = text(await client.callTool({ name: 'describe_data_store', arguments: { store: storeId } }));

    expect(columns[0].autoValue).toBe('created_at');
    expect(columns[1]).not.toHaveProperty('autoValue');
  });

  it('user cannot clear the time of a logged row by patching it with null', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId } = await storeWithColumns(client);
    const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}] } })).ids;

    const refused = await client.callTool({ name: 'update_data_store_rows', arguments: { store: storeId, updates: [{ row_id: rowId, patch: { [tsId]: null } }] } });

    expect(refused.isError).toBe(true);
    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data[tsId]).toBe(DAEMON_TIME);
  });

  it('user cannot rewrite a logged time from the second update of a batch, and the first update is not applied', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId, dueId } = await storeWithColumns(client);
    const [firstRowId, secondRowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}, {}] } })).ids;

    const refused = await client.callTool({
      name: 'update_data_store_rows',
      arguments: { store: storeId, updates: [{ row_id: firstRowId, patch: { [dueId]: FUTURE_TIME } }, { row_id: secondRowId, patch: { [tsId]: FUTURE_TIME } }] },
    });

    expect(refused.isError).toBe(true);
    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data).not.toHaveProperty(dueId);
    expect(rows[1].data[tsId]).toBe(DAEMON_TIME);
  });

  it('user is told the time column was ignored when only a later row of the batch supplies it', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId } = await storeWithColumns(client);

    const inserted = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}, { [tsId]: FUTURE_TIME }] } }));

    expect(inserted.ignored).toEqual([tsId]);
  });
});
