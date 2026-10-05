import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../api/server.js';
import { SCAPE_TOOL_RENAMES } from '../import/scape/scapeToolNames.js';
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
import { WorkingStateService } from '../workingState/workingStateService.js';
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
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, projects, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }) }),
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
      'get_note_version', 'get_session_status', 'get_working_state', 'insert_data_store_rows', 'list_children', 'list_data_store_views', 'list_note_versions',
      'list_notes', 'list_project_folders', 'list_projects', 'list_row_changes', 'list_sessions', 'message_parent', 'move_note', 'pulse_now', 'query_data_store',
      'restore_note_version', 'search_notes', 'send_session_message', 'set_data_store_natural_key', 'update_data_store_row', 'update_data_store_rows', 'update_data_store_view', 'update_note', 'update_note_section',
      'update_session', 'update_working_state',
    ]);
  });

  it('refuses every table tool for a session with no project', async () => {
    const client = await connect(unscopedToken);
    const result = await client.callTool({ name: 'create_data_store', arguments: { display_name: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/no project/i);
  });

  it('surfaces an unexpected error as "error internal_error" with no internal text, and logs it', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    vi.spyOn(stores, 'query').mockImplementation(() => {
      throw new Error('SELECT secret_column FROM ds_rows');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await client.callTool({ name: 'query_data_store', arguments: { store: store.id } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^error internal_error: .* \(retry: later, ref [0-9a-f]{8}\)$/);
    expect(logged).toHaveBeenCalled();
  });

  it('create_data_store scopes the new store to the caller\'s own project', async () => {
    const client = await connect(scopedToken);
    const created = await createStore(client);
    expect(storeRepo.findStore(created.id)?.projectId).toBe('p1');
    expect(created.displayName).toBe('backlog');
  });

  it('describe_data_store returns id, displayName, and columns with id/displayName/columnType/options', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'status', column_type: 'select', options: [{ id: 'todo', label: 'todo' }] } });

    const described = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } }));

    expect(described).toMatchObject({
      id: store.id,
      displayName: 'backlog',
      columns: [{ displayName: 'status', columnType: 'select', options: [{ id: 'todo', label: 'todo' }] }],
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
    expect((result.content as { text: string }[])[0]!.text).toBe('error invalid_body: A select column needs at least one option, each with an id and a label (retry: never)');
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
    expect(inserted).toMatchObject({ ids: [expect.any(String), expect.any(String)], count: 2 });
    expect(JSON.stringify(inserted)).not.toContain('first');

    const updated = text(await client.callTool({
      name: 'update_data_store_rows',
      arguments: { store: store.id, updates: inserted.ids.map((row_id: string) => ({ row_id, patch: { [titleId]: 'changed' } })) },
    }));
    expect(updated).toMatchObject({ ids: inserted.ids, count: 2 });
    expect(JSON.stringify(updated)).not.toContain('changed');
  });

  it('insert_data_store_rows refuses more than 500 rows in one batch', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    const rows = Array.from({ length: 501 }, () => ({}));
    const result = await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows } });
    expect(result.isError).toBe(true);
  });

  it('update_data_store_rows writes actor-attributed history for each row and commits the good updates of a batch beside a bad one', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'status', column_type: 'select', options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] } });
    const statusId = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns[0].id;
    const [row1Id, row2Id] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [statusId]: 'todo' }, { [statusId]: 'todo' }] } })).ids;

    const mixedBatch = text(await client.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: row1Id, patch: { [statusId]: 'done' } }, { row_id: row2Id, patch: { [statusId]: 'not-an-option' } }] } }));
    expect(mixedBatch).toMatchObject({ updated: 1, failed: 1, updatedRowIDs: [row1Id] });
    const afterMixedBatch = text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id } }));
    expect(afterMixedBatch.rows.find((r: { id: string }) => r.id === row2Id).data[statusId]).toBe('todo');

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
    expect(result).toMatchObject({ truncated: true, count: 1 });
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

  it('query_data_store fills the 1 MiB budget with compact rows, leaving less than one row unused', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'blob', column_type: 'text' } });
    const blobId = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns[0].id;
    const mediumValue = 'x'.repeat(2 * 1024);
    for (let batch = 0; batch < 30; batch++) {
      const rows = Array.from({ length: 20 }, () => ({ [blobId]: mediumValue }));
      await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows } });
    }

    const result = text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id, limit: 600 } }));

    const rowBytes = Buffer.byteLength(JSON.stringify(result.rows[0]), 'utf8');
    const keptBytes = result.rows.length * rowBytes;
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(result.rows.length);
    expect(keptBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(1024 * 1024 - keptBytes).toBeLessThan(rowBytes);
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

    expect(text(refused)).toMatchObject({ updated: 0, failed: 1 });
    expect(text(refused).failures[0]).toMatch(/set by the daemon/i);
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

    expect(text(refused)).toMatchObject({ updated: 0, failed: 1 });
    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data[tsId]).toBe(DAEMON_TIME);
  });

  it('user cannot rewrite a logged time from the second update of a batch, which fails alone while the first update is applied', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId, dueId } = await storeWithColumns(client);
    const [firstRowId, secondRowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}, {}] } })).ids;

    const refused = await client.callTool({
      name: 'update_data_store_rows',
      arguments: { store: storeId, updates: [{ row_id: firstRowId, patch: { [dueId]: FUTURE_TIME } }, { row_id: secondRowId, patch: { [tsId]: FUTURE_TIME } }] },
    });

    expect(text(refused)).toMatchObject({ updated: 1, failed: 1 });
    expect(text(refused).failures[0]).toMatch(/^row 2: .*set by the daemon/);
    const { rows } = text(await client.callTool({ name: 'query_data_store', arguments: { store: storeId } }));
    expect(rows[0].data[dueId]).toBe(FUTURE_TIME);
    expect(rows[1].data[tsId]).toBe(DAEMON_TIME);
  });

  it('user is told the time column was ignored when only a later row of the batch supplies it', async () => {
    const client = await connect(scopedToken);
    const { storeId, tsId } = await storeWithColumns(client);

    const inserted = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: storeId, rows: [{}, { [tsId]: FUTURE_TIME }] } }));

    expect(inserted.ignored).toEqual([tsId]);
  });
});

describe('update_data_store_row', () => {
  const errorTextOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

  async function backlogWithTwoRows(client: Client) {
    const store = await createStore(client, 'backlog');
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'id', column_type: 'text', natural_key: true } });
    await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'title', column_type: 'text' } });
    await client.callTool({
      name: 'add_data_store_column',
      arguments: { store: store.id, display_name: 'status', column_type: 'select', options: [{ id: 'opt-todo', label: 'todo' }, { id: 'opt-done', label: 'Done' }] },
    });
    const described = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } }));
    const [idColumn, titleColumn, statusColumn] = described.columns;
    const { ids } = text(await client.callTool({
      name: 'insert_data_store_rows',
      arguments: { store: store.id, rows: [{ [idColumn.id]: 'IT-1', [titleColumn.id]: 'first' }, { [idColumn.id]: 'IT-2', [titleColumn.id]: 'second' }] },
    }));
    const dataOf = async (rowId: string) =>
      text(await client.callTool({ name: 'query_data_store', arguments: { store: store.id } })).rows.find((row: { id: string }) => row.id === rowId).data;
    return { storeId: store.id as string, idColumnId: idColumn.id as string, titleColumnId: titleColumn.id as string, statusColumnId: statusColumn.id as string, firstRowId: ids[0] as string, secondRowId: ids[1] as string, described, dataOf };
  }

  it('is one of the tools an agent can list', async () => {
    const client = await connect(scopedToken);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain('update_data_store_row');
  });

  it('changes the cells named by column display name, in any case, of the row given by row_id, and leaves the other cells alone', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId, idColumnId, titleColumnId, dataOf } = await backlogWithTwoRows(client);

    const result = text(await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { TITLE: 'renamed' } } }));

    expect(result).toEqual({ id: firstRowId });
    expect(await dataOf(firstRowId)).toEqual({ [idColumnId]: 'IT-1', [titleColumnId]: 'renamed' });
  });

  it('accepts the column id in place of its display name', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId, titleColumnId, dataOf } = await backlogWithTwoRows(client);

    await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { [titleColumnId]: 'by id' } } });

    expect((await dataOf(firstRowId))[titleColumnId]).toBe('by id');
  });

  it('finds the row by the value of the natural key column', async () => {
    const client = await connect(scopedToken);
    const { storeId, secondRowId, titleColumnId, dataOf } = await backlogWithTwoRows(client);

    const result = text(await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, key: 'IT-2', values: { title: 'by key' } } }));

    expect(result).toEqual({ id: secondRowId });
    expect((await dataOf(secondRowId))[titleColumnId]).toBe('by key');
  });

  it('finds the store by its display name', async () => {
    const client = await connect(scopedToken);
    const { firstRowId, titleColumnId, dataOf } = await backlogWithTwoRows(client);

    await client.callTool({ name: 'update_data_store_row', arguments: { store: 'BACKLOG', row_id: firstRowId, values: { title: 'by store name' } } });

    expect((await dataOf(firstRowId))[titleColumnId]).toBe('by store name');
  });

  it('records the change in the row history as the calling agent', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId, titleColumnId } = await backlogWithTwoRows(client);

    await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { title: 'renamed' } } });

    const [latest] = storeRepo.rowHistory(firstRowId, { projectId: 'p1' });
    expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { [titleColumnId]: { from: 'first', to: 'renamed' } } });
  });

  it('turns the label of a select option, in any case, into its id, and keeps an id as it is', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId, secondRowId, statusColumnId, dataOf } = await backlogWithTwoRows(client);

    await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { status: 'done' } } });
    await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: secondRowId, values: { status: 'opt-todo' } } });

    expect(storeRepo.listRows(storeId).map((row) => row.data[statusColumnId])).toEqual(['opt-done', 'opt-todo']);
    expect((await dataOf(firstRowId))[statusColumnId]).toBe('Done');
    expect((await dataOf(secondRowId))[statusColumnId]).toBe('todo');
  });

  it('refuses a select value that is neither an option label nor an id, and writes nothing', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId, titleColumnId, dataOf } = await backlogWithTwoRows(client);

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { title: 'changed', status: 'blocked' } } });

    expect(result.isError).toBe(true);
    expect((await dataOf(firstRowId))[titleColumnId]).toBe('first');
  });

  it('refuses an unknown column name and writes nothing, even for the valid cells', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId, titleColumnId, dataOf } = await backlogWithTwoRows(client);

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { title: 'changed', nope: 'x' } } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/nope/);
    expect((await dataOf(firstRowId))[titleColumnId]).toBe('first');
  });

  it.each([
    ['both row_id and key', { row_id: 'r', key: 'IT-1' }],
    ['neither row_id nor key', {}],
  ])('refuses %s', async (_description, address) => {
    const client = await connect(scopedToken);
    const { storeId } = await backlogWithTwoRows(client);

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, values: { title: 'x' }, ...address } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/^error invalid_body: .*exactly one of row_id or key/);
  });

  it('refuses empty values', async () => {
    const client = await connect(scopedToken);
    const { storeId, firstRowId } = await backlogWithTwoRows(client);

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: {} } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/at least one/);
  });

  it('answers "row not found" for a key no row holds', async () => {
    const client = await connect(scopedToken);
    const { storeId } = await backlogWithTwoRows(client);

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, key: 'IT-404', values: { title: 'x' } } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/row not found|does not exist/);
  });

  it('refuses a key held by several rows and changes none', async () => {
    const client = await connect(scopedToken);
    const { storeId, idColumnId, firstRowId, titleColumnId, dataOf } = await backlogWithTwoRows(client);
    storeRepo.insertRow(storeId, { id: 'legacy-duplicate', at: '2026-01-01T00:00:00.000Z', data: { [idColumnId]: 'IT-1' }, actor: { kind: 'human', label: 'test' } });

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: storeId, key: 'IT-1', values: { title: 'x' } } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/several rows/i);
    expect((await dataOf(firstRowId))[titleColumnId]).toBe('first');
  });

  it('refuses a key on a store that has no natural key', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client, 'plain');

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: store.id, key: 'IT-1', values: { title: 'x' } } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/no natural key/);
  });

  it('cannot reach a row of a store of another project, and says what it says for a row that does not exist', async () => {
    const owner = await connect(scopedToken);
    const { storeId, firstRowId } = await backlogWithTwoRows(owner);
    const stranger = await connect(otherToken);

    const foreign = await stranger.callTool({ name: 'update_data_store_row', arguments: { store: storeId, row_id: firstRowId, values: { title: 'x' } } });
    const missing = await stranger.callTool({ name: 'update_data_store_row', arguments: { store: 'does-not-exist', row_id: firstRowId, values: { title: 'x' } } });

    expect(foreign.isError).toBe(true);
    expect(errorTextOf(foreign)).toBe(errorTextOf(missing));
  });

  it('refuses a row id that belongs to another store of the same project', async () => {
    const client = await connect(scopedToken);
    const { firstRowId } = await backlogWithTwoRows(client);
    const otherStore = await createStore(client, 'other');
    await client.callTool({ name: 'add_data_store_column', arguments: { store: otherStore.id, display_name: 'title', column_type: 'text' } });

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: otherStore.id, row_id: firstRowId, values: { title: 'x' } } });

    expect(result.isError).toBe(true);
  });

  it('refuses a session that has no project', async () => {
    const client = await connect(unscopedToken);

    const result = await client.callTool({ name: 'update_data_store_row', arguments: { store: 'x', row_id: 'r', values: { title: 'x' } } });

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toMatch(/no project/i);
  });
});

describe('Scape tool renames of the manager mission import', () => {
  it('only point at tools the server registers', async () => {
    const client = await connect(scopedToken);
    const { tools } = await client.listTools();
    const registeredToolNames = new Set(tools.map((tool) => tool.name));

    const renamedToUnregisteredTool = Object.values(SCAPE_TOOL_RENAMES).filter((openFleetToolName) => !registeredToolNames.has(openFleetToolName));

    expect(renamedToUnregisteredTool).toEqual([]);
  });
});

describe('natural key columns', () => {
  it('add_data_store_column natural_key makes the column the store natural key, and describe_data_store reports it', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);

    const column = text(await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'id', column_type: 'text', natural_key: true } }));

    const described = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } }));
    expect(described.naturalKeyColumnId).toBe(column.id);
  });

  it('describe_data_store has no naturalKeyColumnId on a store without one', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);

    const described = text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } }));

    expect(described).not.toHaveProperty('naturalKeyColumnId');
  });

  it('refuses a natural key column that is not text, and adds no column', async () => {
    const client = await connect(scopedToken);
    const store = await createStore(client);

    const result = await client.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'priority', column_type: 'number', natural_key: true } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^error invalid_body: .*text column/);
    expect(text(await client.callTool({ name: 'describe_data_store', arguments: { store: store.id } })).columns).toEqual([]);
  });
});
