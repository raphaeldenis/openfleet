import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { newId } from '../ids.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from './mcpServer.js';

const WORKTREES_ROOT = '/tmp/of-wt';
const CHILD_COUNT = 10;

const BYTE_BUDGET = {
  createSession: 200,
  getSessionStatus: 200,
  listChildren: 1600,
  listSessions: 1800,
  getArgusStatus: 1500,
  listNotes: 2700,
  searchNotes: 3000,
  describeDataStore: 1600,
  queryDataStore: 34000,
  getWorkingState: 200,
};
const NOTE_COUNT = 20;
const COLUMN_COUNT = 12;
const ROW_COUNT = 50;

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let client: Client;
let createdDirectories: string[] = [];
let parentId: string;

function existingWorktreeDir(name: string): string {
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  const privateParent = mkdtempSync(join(WORKTREES_ROOT, 'run-'));
  createdDirectories.push(privateParent);
  const path = join(privateParent, name);
  mkdirSync(path);
  return path;
}

const rawText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));
const bytesOf = (result: unknown) => Buffer.byteLength(rawText(result), 'utf8');

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: WORKTREES_ROOT, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: WORKTREES_ROOT }),
  });
  const parent = await sessions.create({ directory: '/tmp', name: 'Lead', harness: 'fake', emoji: '🧭' });
  parentId = parent.id;
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', parent.id);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${harness.launches[0]!.mcpToken}` } } }));
});
afterEach(async () => {
  await server.close();
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
  createdDirectories = [];
});

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

async function spawnChildren(count: number) {
  for (let index = 0; index < count; index += 1) {
    await call('create_session', { directory: existingWorktreeDir(`child-${index}`), name: `Worker ${index}`, emoji: '🛠️', seeded_prompt: 'do the task' });
  }
}

async function seedTable() {
  const store = parsed(await call('create_data_store', { display_name: 'backlog' }));
  const columnIds: string[] = [];
  for (let index = 0; index < COLUMN_COUNT; index += 1) {
    const isSelect = index % 4 === 0;
    const column = parsed(await call('add_data_store_column', {
      store: store.id, display_name: `column ${index}`, column_type: isSelect ? 'select' : 'text',
      ...(isSelect ? { options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] } : {}),
    }));
    columnIds.push(column.id);
  }
  const rows = Array.from({ length: ROW_COUNT }, (_, rowIndex) => Object.fromEntries(columnIds.map((id, index) => [id, index % 4 === 0 ? 'todo' : `value ${rowIndex}-${index}`])));
  await call('insert_data_store_rows', { store: store.id, rows });
  return store.id as string;
}


const isCompactJson = (result: unknown) => rawText(result) === JSON.stringify(JSON.parse(rawText(result)));
const keysOf = (value: object) => Object.keys(value).sort();

describe('MCP tool results are compact', () => {
  describe('session tools', () => {
    it('agent can read a spawned child in a compact result that keeps its id, name and state', async () => {
      const result = await call('create_session', { directory: existingWorktreeDir('measured'), name: 'Gimli', emoji: '⚔️' });

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.createSession);
      const child = parsed(result);
      expect(child).toMatchObject({ name: 'Gimli', emoji: '⚔️', state: 'starting' });
      expect(child.id).toEqual(expect.any(String));
      expect(child.stateSince).toEqual(expect.any(String));
      expect(child).not.toHaveProperty('directory');
      expect(child).not.toHaveProperty('harness');
      expect(child).not.toHaveProperty('createdAt');
      expect(child).not.toHaveProperty('permissionMode');
    });

    it('agent can read a child status within the byte budget', async () => {
      const created = parsed(await call('create_session', { directory: existingWorktreeDir('status'), name: 'Gimli' }));

      const result = await call('get_session_status', { session_id: created.id });

      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.getSessionStatus);
      expect(parsed(result)).toMatchObject({ id: created.id, name: 'Gimli', state: 'starting' });
    });

    it('agent can list ten children within the byte budget, each with id, name and state', async () => {
      await spawnChildren(CHILD_COUNT);

      const result = await call('list_children');

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.listChildren);
      const children = parsed(result);
      expect(children).toHaveLength(CHILD_COUNT);
      for (const child of children) {
        expect(child).toMatchObject({ state: 'starting' });
        expect(child.id).toEqual(expect.any(String));
        expect(child.name).toEqual(expect.any(String));
      }
    });

    it('agent can list its descendants within the byte budget, each with its parentId', async () => {
      await spawnChildren(CHILD_COUNT);

      const result = await call('list_sessions');

      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.listSessions);
      const listed = parsed(result);
      expect(listed).toHaveLength(CHILD_COUNT + 1);
      const children = listed.filter((session: { id: string }) => session.id !== parentId);
      for (const child of children) expect(child.parentId).toBe(parentId);
    });

    it('agent can read the fleet status within the byte budget, with each child id, name, state and queued count', async () => {
      await spawnChildren(CHILD_COUNT);

      const result = await call('get_argus_status');

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.getArgusStatus);
      const { manager, children } = parsed(result);
      expect(manager).toBeNull();
      expect(children).toHaveLength(CHILD_COUNT);
      for (const child of children) {
        expect(child.id).toEqual(expect.any(String));
        expect(child.name).toEqual(expect.any(String));
        expect(child.state).toBe('starting');
        expect(child.stateSince).toEqual(expect.any(String));
        expect(child.queuedMessageCount).toBe(0);
        expect(child).not.toHaveProperty('emoji');
      }
    });

    it('agent keeps the retry instruction when it spawns a duplicate child', async () => {
      const directory = existingWorktreeDir('twin');
      await call('create_session', { directory, name: 'Gimli' });

      const refusal = await call('create_session', { directory, name: 'Gimli' });

      expect(refusal.isError).toBe(true);
      expect(rawText(refusal)).toMatch(/send_session_message.*close_session.*allow_duplicate/);
    });
  });

  describe('note tools', () => {
    it('agent can list twenty notes within the byte budget, each with id, title, rev and folder', async () => {
      for (let index = 0; index < NOTE_COUNT; index += 1) await call('create_note', { title: `Note ${index}`, body_md: `body ${index}` });

      const result = await call('list_notes');

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.listNotes);
      const { notes, count, truncated } = parsed(result);
      expect(count).toBe(NOTE_COUNT);
      expect(truncated).toBe(false);
      for (const note of notes) {
        expect(keysOf(note)).toEqual(['fileBacked', 'folder', 'id', 'rev', 'shared', 'title']);
      }
    });

    it('agent can search notes within the byte budget, each hit with id, title, rev and snippet', async () => {
      for (let index = 0; index < NOTE_COUNT; index += 1) await call('create_note', { title: `Note ${index}`, body_md: `body ${index}` });

      const result = await call('search_notes', { query: 'Note' });

      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.searchNotes);
      const { results, count } = parsed(result);
      expect(count).toBe(NOTE_COUNT);
      expect(keysOf(results[0])).toEqual(['fileBacked', 'folder', 'id', 'rev', 'shared', 'snippet', 'title']);
    });

    it('agent can chain note edits from the ack alone: it carries the id and new rev but not the body it just sent', async () => {
      const created = parsed(await call('create_note', { title: 'Plan', body_md: '# v1' }));
      expect(keysOf(created)).toEqual(['fileBacked', 'folder', 'id', 'rev', 'shared', 'title']);

      const updated = parsed(await call('update_note', { note: created.id, body_md: '# v2', expected_rev: created.rev }));
      const appended = parsed(await call('append_to_note', { note: created.id, content: 'more' }));
      const sectioned = parsed(await call('update_note_section', { note: created.id, heading: 'H', content: 'x', expected_rev: appended.rev }));
      const moved = parsed(await call('move_note', { note: created.id, folder: null }));
      const restored = parsed(await call('restore_note_version', { note: created.id, rev: 1 }));

      expect([updated.rev, appended.rev, sectioned.rev, moved.rev, restored.rev]).toEqual([2, 3, 4, 4, 5]);
      for (const ack of [updated, appended, sectioned, moved, restored]) expect(ack).not.toHaveProperty('bodyMd');
    });

    it('agent keeps the current rev when an edit is stale', async () => {
      const created = parsed(await call('create_note', { title: 'Plan', body_md: '# v1' }));
      await call('update_note', { note: created.id, body_md: '# v2', expected_rev: 1 });

      const stale = await call('update_note', { note: created.id, body_md: '# v3', expected_rev: 1 });

      expect(stale.isError).toBe(true);
      expect(rawText(stale)).toBe('409 stale_revision, current rev: 2');
    });

    it('agent reads a note without a duplicated expandedBody when no mention was expanded', async () => {
      const created = parsed(await call('create_note', { title: 'Plain', body_md: 'just text' }));

      const note = parsed(await call('get_note', { note: created.id }));

      expect(note).toMatchObject({ id: created.id, rev: 1, bodyMd: 'just text' });
      expect(note).not.toHaveProperty('expandedBody');
      expect(note).not.toHaveProperty('projectId');
      expect(note).not.toHaveProperty('createdAt');
      expect(note).not.toHaveProperty('docsRelativePath');
    });

    it('agent reads the expanded text of a note whose mention was expanded', async () => {
      const mentioned = parsed(await call('create_note', { title: 'Target', body_md: 'target body', shared: true }));
      const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${mentioned.id}` }));

      const note = parsed(await call('get_note', { note: created.id }));

      expect(note.bodyMd).toBe(`see @note:${mentioned.id}`);
      expect(note.expandedBody).toContain('target body');
    });
  });

  describe('table tools', () => {
    it('agent can describe a twelve-column table within the byte budget, with every column id, name and type', async () => {
      const storeId = await seedTable();

      const result = await call('describe_data_store', { store: storeId });

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.describeDataStore);
      const described = parsed(result);
      expect(described).toMatchObject({ id: storeId, displayName: 'backlog' });
      expect(described.columns).toHaveLength(COLUMN_COUNT);
      expect(described.columns[0]).toMatchObject({ displayName: 'column 0', columnType: 'select', options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] });
      expect(described.columns[1]).toMatchObject({ displayName: 'column 1', columnType: 'text' });
      for (const column of described.columns) {
        expect(column.id).toEqual(expect.any(String));
        expect(column).not.toHaveProperty('sortOrder');
      }
    });

    it('agent can query fifty rows within the byte budget, with row ids, data, count and truncated', async () => {
      const storeId = await seedTable();

      const result = await call('query_data_store', { store: storeId, limit: ROW_COUNT });

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.queryDataStore);
      const { rows, count, truncated } = parsed(result);
      expect(count).toBe(ROW_COUNT);
      expect(truncated).toBe(false);
      for (const row of rows) {
        expect(keysOf(row)).toEqual(['data', 'id', 'updatedAt']);
        expect(Object.keys(row.data)).toHaveLength(COLUMN_COUNT);
      }
    });

    it('agent keeps ids and counts from a batch insert and gets a trimmed store and column on creation', async () => {
      const store = parsed(await call('create_data_store', { display_name: 'tasks' }));
      const column = parsed(await call('add_data_store_column', { store: store.id, display_name: 'title', column_type: 'text' }));
      const inserted = parsed(await call('insert_data_store_rows', { store: store.id, rows: [{ [column.id]: 'a' }, { [column.id]: 'b' }] }));

      expect(keysOf(store)).toEqual(['displayName', 'id']);
      expect(keysOf(column)).toEqual(['columnType', 'displayName', 'id']);
      expect(inserted.count).toBe(2);
      expect(inserted.ids).toHaveLength(2);
    });

    it('agent reads a trimmed row history and saved views', async () => {
      const store = parsed(await call('create_data_store', { display_name: 'tasks' }));
      const column = parsed(await call('add_data_store_column', { store: store.id, display_name: 'title', column_type: 'text' }));
      const { ids } = parsed(await call('insert_data_store_rows', { store: store.id, rows: [{ [column.id]: 'a' }] }));
      const view = parsed(await call('create_data_store_view', { store: store.id, display_name: 'main', view_type: 'grid' }));

      const history = parsed(await call('list_row_changes', { row_id: ids[0] }));
      const views = parsed(await call('list_data_store_views', { store: store.id }));

      expect(history.count).toBe(1);
      expect(history.truncated).toBe(false);
      expect(keysOf(history.entries[0])).toEqual(['actorKind', 'actorLabel', 'change', 'createdAt']);
      expect(keysOf(view)).toEqual(['config', 'displayName', 'id', 'viewType']);
      expect(views).toEqual([view]);
    });
  });

  describe('working state tools', () => {
    const sections = { plan: ['a'], todo: ['b'], remaining: [], questions_for_human: [], internal_questions: [], blockers: ['c'] };

    it('agent gets the update time back from a working state update and reads its sections within the byte budget', async () => {
      const updated = parsed(await call('update_working_state', sections));

      const result = await call('get_working_state');

      expect(updated.updated_at).toEqual(expect.any(String));
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.getWorkingState);
      const state = parsed(result);
      expect(state).toMatchObject({ plan: ['a'], todo: ['b'], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: ['c'] });
      expect(state.updatedAt).toEqual(expect.any(String));
      expect(state).not.toHaveProperty('sessionId');
    });

    it('agent reads a null state when none is recorded', async () => {
      expect(parsed(await call('get_working_state'))).toEqual({ state: null });
    });
  });
});
