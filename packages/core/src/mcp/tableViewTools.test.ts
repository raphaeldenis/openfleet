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

function assignProject(sessionId: string, projectId: string): void {
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId);
}

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);
const errorText = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

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
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `note-${++counter}` });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });
  stores =new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }) }),
  });

  const scoped = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  assignProject(scoped.id, 'p1');
  const other = await sessions.create({ directory: '/tmp', name: 'Legolas', harness: 'fake', emoji: '🏹' });
  assignProject(other.id, 'p2');
  scopedToken = harness.launches[0]!.mcpToken;
  otherToken = harness.launches[1]!.mcpToken;
});
afterEach(() => {
  vi.restoreAllMocks();
  return server.close();
});

async function createStore(client: Client, displayName = 'backlog') {
  return text(await client.callTool({ name: 'create_data_store', arguments: { display_name: displayName } }));
}
async function addSelectColumn(client: Client, storeId: string, displayName = 'status') {
  await client.callTool({
    name: 'add_data_store_column',
    arguments: { store: storeId, display_name: displayName, column_type: 'select', options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] },
  });
  const columns = text(await client.callTool({ name: 'describe_data_store', arguments: { store: storeId } })).columns;
  return columns.find((c: { displayName: string }) => c.displayName === displayName).id as string;
}
async function addTextColumn(client: Client, storeId: string, displayName = 'title') {
  await client.callTool({ name: 'add_data_store_column', arguments: { store: storeId, display_name: displayName, column_type: 'text' } });
  const columns = text(await client.callTool({ name: 'describe_data_store', arguments: { store: storeId } })).columns;
  return columns.find((c: { displayName: string }) => c.displayName === displayName).id as string;
}

describe('table view tools', () => {
  describe('create_data_store_view', () => {
    it('creates a grid view scoped to the caller\'s project', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);

      const view = text(await client.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } }));

      expect(view).toMatchObject({ displayName: 'main', viewType: 'grid' });
      expect(text(await client.callTool({ name: 'list_data_store_views', arguments: { store: store.id } }))).toEqual([view]);
    });

    it('on another project\'s store fails exactly like a missing store', async () => {
      const owner = await connect(scopedToken);
      const store = await createStore(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } });
      const missingResult = await stranger.callTool({ name: 'create_data_store_view', arguments: { store: 'does-not-exist', display_name: 'main', view_type: 'grid' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('refuses a kanban view whose groupByColumnId is not a select column of the same store', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);

      const result = await client.callTool({
        name: 'create_data_store_view',
        arguments: { store: store.id, display_name: 'board', view_type: 'kanban', config: { groupByColumnId: titleId } },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/select column/i);
    });

    it('accepts a kanban view whose groupByColumnId is a select column of the same store', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const statusId = await addSelectColumn(client, store.id);

      const result = await client.callTool({
        name: 'create_data_store_view',
        arguments: { store: store.id, display_name: 'board', view_type: 'kanban', config: { groupByColumnId: statusId } },
      });

      expect(result.isError).toBeFalsy();
    });
  });

  describe('list_data_store_views', () => {
    it('lists a store\'s views in creation order', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      await client.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'one', view_type: 'grid' } });
      await client.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'two', view_type: 'grid' } });

      const views = text(await client.callTool({ name: 'list_data_store_views', arguments: { store: store.id } }));

      expect(views.map((v: { displayName: string }) => v.displayName)).toEqual(['one', 'two']);
    });

    it('on another project\'s store fails exactly like a missing store', async () => {
      const owner = await connect(scopedToken);
      const store = await createStore(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'list_data_store_views', arguments: { store: store.id } });
      const missingResult = await stranger.callTool({ name: 'list_data_store_views', arguments: { store: 'does-not-exist' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });
  });

  describe('view config size cap', () => {
    const oversizeWhere = (columnId: string) => Array.from({ length: 400 }, () => ({ columnId, op: 'eq', value: 'v'.repeat(40) }));

    it('refuses an oversize config on create', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);

      const result = await client.callTool({
        name: 'create_data_store_view',
        arguments: { store: store.id, display_name: 'big', view_type: 'grid', config: { where: oversizeWhere(titleId) } },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/too large/i);
    });

    it('refuses an oversize config on update', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);
      const view = text(await client.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } }));

      const result = await client.callTool({ name: 'update_data_store_view', arguments: { view: view.id, config: { where: oversizeWhere(titleId) } } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/too large/i);
    });
  });

  describe('update_data_store_view', () => {
    it('replaces a view\'s config', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);
      const view = text(await client.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } }));

      const updated = text(await client.callTool({
        name: 'update_data_store_view',
        arguments: { view: view.id, config: { orderBy: [{ columnId: titleId, dir: 'desc' }] } },
      }));

      expect(updated.config).toEqual({ orderBy: [{ columnId: titleId, dir: 'desc' }] });
      const listed = text(await client.callTool({ name: 'list_data_store_views', arguments: { store: store.id } }));
      expect(listed[0].config).toEqual({ orderBy: [{ columnId: titleId, dir: 'desc' }] });
    });

    it('on another project\'s view fails exactly like a missing view', async () => {
      const owner = await connect(scopedToken);
      const store = await createStore(owner);
      const view = text(await owner.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } }));
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'update_data_store_view', arguments: { view: view.id, config: {} } });
      const missingResult = await stranger.callTool({ name: 'update_data_store_view', arguments: { view: 'does-not-exist', config: {} } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('refuses moving a kanban view\'s groupByColumnId off a select column', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const statusId = await addSelectColumn(client, store.id);
      const titleId = await addTextColumn(client, store.id);
      const view = text(await client.callTool({
        name: 'create_data_store_view',
        arguments: { store: store.id, display_name: 'board', view_type: 'kanban', config: { groupByColumnId: statusId } },
      }));

      const result = await client.callTool({ name: 'update_data_store_view', arguments: { view: view.id, config: { groupByColumnId: titleId } } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/select column/i);
    });
  });

  describe('unexpected errors', () => {
    it('surface as "error internal_error" with no internal text, and are logged', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      vi.spyOn(stores, 'listViews').mockImplementation(() => {
        throw new Error('SELECT secret_column FROM ds_views');
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await client.callTool({ name: 'list_data_store_views', arguments: { store: store.id } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/^error internal_error: .* \(retry: later, ref [0-9a-f]{8}\)$/);
      expect(logged).toHaveBeenCalled();
    });
  });

  describe('delete_data_store_view', () => {
    it('deletes a view', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const view = text(await client.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } }));

      const result = await client.callTool({ name: 'delete_data_store_view', arguments: { view: view.id } });

      expect(result.isError).toBeFalsy();
      const listed = text(await client.callTool({ name: 'list_data_store_views', arguments: { store: store.id } }));
      expect(listed).toEqual([]);
    });

    it('on another project\'s view fails exactly like a missing view', async () => {
      const owner = await connect(scopedToken);
      const store = await createStore(owner);
      const view = text(await owner.callTool({ name: 'create_data_store_view', arguments: { store: store.id, display_name: 'main', view_type: 'grid' } }));
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'delete_data_store_view', arguments: { view: view.id } });
      const missingResult = await stranger.callTool({ name: 'delete_data_store_view', arguments: { view: 'does-not-exist' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });
  });

  describe('list_row_changes', () => {
    it('returns entries newest first with actorKind/actorLabel/change/createdAt, defaulting the limit to 100', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);
      const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [titleId]: 'first' }] } })).ids;
      await client.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: rowId, patch: { [titleId]: 'second' } }] } });

      const result = text(await client.callTool({ name: 'list_row_changes', arguments: { row_id: rowId } }));

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { [titleId]: { from: 'first', to: 'second' } } });
      expect(result.entries[0]).toHaveProperty('createdAt');
      expect(result.entries[1]).toMatchObject({ change: { kind: 'create' } });
    });

    it('on another project\'s row fails exactly like a missing row', async () => {
      const owner = await connect(scopedToken);
      const store = await createStore(owner);
      const [rowId] = text(await owner.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } })).ids;
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'list_row_changes', arguments: { row_id: rowId } });
      const missingResult = await stranger.callTool({ name: 'list_row_changes', arguments: { row_id: 'does-not-exist' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('stays readable in its own project as a tombstone after the row is deleted, but never in another project', async () => {
      const owner = await connect(scopedToken);
      const store = await createStore(owner);
      const [rowId] = text(await owner.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } })).ids;
      await owner.callTool({ name: 'delete_data_store_row', arguments: { row_id: rowId } });

      const ownResult = text(await owner.callTool({ name: 'list_row_changes', arguments: { row_id: rowId } }));
      expect(ownResult.entries.map((e: { change: unknown }) => e.change)).toEqual([{ kind: 'delete' }, { kind: 'create' }]);

      const stranger = await connect(otherToken);
      const strangerResult = await stranger.callTool({ name: 'list_row_changes', arguments: { row_id: rowId } });
      expect(strangerResult.isError).toBe(true);
    });

    it('cuts a hot row\'s history off past 1 MiB and flags it truncated', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);
      const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [titleId]: 'x' }] } })).ids;
      const largeCells = ['a', 'b'].map((letter) => letter.repeat(60 * 1024));
      for (let update = 0; update < 20; update++) {
        await client.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: rowId, patch: { [titleId]: largeCells[update % 2] } }] } });
      }

      const result = text(await client.callTool({ name: 'list_row_changes', arguments: { row_id: rowId } }));

      expect(result.truncated).toBe(true);
      expect(result.count).toBeLessThan(21);
      expect(result.entries).toHaveLength(result.count);
      expect(JSON.stringify(result.entries).length).toBeLessThanOrEqual(1024 * 1024);
    });

    it('fills the 1 MiB history budget with compact entries, leaving less than one entry unused', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const titleId = await addTextColumn(client, store.id);
      const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [titleId]: 'x' }] } })).ids;
      const mediumCells = ['a', 'b'].map((letter) => letter.repeat(1200));
      for (let update = 0; update < 520; update++) {
        await client.callTool({ name: 'update_data_store_rows', arguments: { store: store.id, updates: [{ row_id: rowId, patch: { [titleId]: mediumCells[update % 2] } }] } });
      }

      const result = text(await client.callTool({ name: 'list_row_changes', arguments: { row_id: rowId, limit: 500 } }));

      const bytesOfEntries = result.entries.map((entry: unknown) => Buffer.byteLength(JSON.stringify(entry), 'utf8'));
      const entryBytes = Math.max(...bytesOfEntries);
      const keptBytes = bytesOfEntries.reduce((sum: number, bytes: number) => sum + bytes, 0);
      expect(result.truncated).toBe(true);
      expect(result.count).toBe(result.entries.length);
      expect(keptBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(1024 * 1024 - keptBytes).toBeLessThan(entryBytes);
    });

    it('flags a short history as not truncated', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } })).ids;

      const result = text(await client.callTool({ name: 'list_row_changes', arguments: { row_id: rowId } }));

      expect(result).toMatchObject({ truncated: false, count: 1 });
    });

    it('refuses a limit over 500', async () => {
      const client = await connect(scopedToken);
      const store = await createStore(client);
      const [rowId] = text(await client.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{}] } })).ids;

      const result = await client.callTool({ name: 'list_row_changes', arguments: { row_id: rowId, limit: 501 } });

      expect(result.isError).toBe(true);
    });
  });
});
