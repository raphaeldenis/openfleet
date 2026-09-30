import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
  createSession: 210,
  getSessionStatus: 205,
  listChildren: 2130,
  listSessions: 2850,
  getArgusStatus: 1640,
  listNotes: 2680,
  searchNotes: 3090,
  describeDataStore: 1540,
  queryDataStore: 38600,
  queryDataStoreColumnar: 11900,
  getWorkingState: 160,
};
const NOTE_COUNT = 20;
const COLUMN_COUNT = 12;
const ROW_COUNT = 50;

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let harness: FakeHarness;
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
  harness = new FakeHarness();
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

async function spawnChildren(count: number): Promise<string[]> {
  const directories: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const directory = existingWorktreeDir(`child-${index}`);
    await call('create_session', { directory, name: `Worker ${index}`, emoji: '🛠️', seeded_prompt: 'do the task' });
    directories.push(directory);
  }
  return directories;
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
      const directory = existingWorktreeDir('measured');

      const result = await call('create_session', { directory, name: 'Gimli', emoji: '⚔️' });

      expect(isCompactJson(result)).toBe(true);
      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.createSession);
      const child = parsed(result);
      expect(child).toMatchObject({ name: 'Gimli', emoji: '⚔️', state: 'starting' });
      expect(child.id).toEqual(expect.any(String));
      expect(child.stateSince).toEqual(expect.any(String));
      expect(child.directory).toBe(realpathSync.native(directory));
      expect(child).not.toHaveProperty('harness');
      expect(child).not.toHaveProperty('createdAt');
      expect(child).not.toHaveProperty('permissionMode');
    });

    it('agent can read a child status within the byte budget', async () => {
      const directory = existingWorktreeDir('status');
      const created = parsed(await call('create_session', { directory, name: 'Gimli' }));

      const result = await call('get_session_status', { session_id: created.id });

      expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.getSessionStatus);
      expect(parsed(result)).toMatchObject({ id: created.id, name: 'Gimli', state: 'starting', directory: realpathSync.native(directory) });
    });

    it('agent reads the resolved model, the model it drifted from, the worktree and the branch of a child that has them', async () => {
      const created = parsed(await call('create_session', { directory: existingWorktreeDir('resolved'), name: 'Gimli' }));
      db.prepare('UPDATE sessions SET resolved_model = ?, model_drifted_from = ?, worktree = ?, branch = ? WHERE id = ?')
        .run('claude-sonnet-x', 'claude-sonnet-w', '/tmp/of-worktrees/resolved', 'feature/resolved', created.id);

      const status = parsed(await call('get_session_status', { session_id: created.id }));

      expect(status).toMatchObject({ resolvedModel: 'claude-sonnet-x', modelDriftedFrom: 'claude-sonnet-w', worktree: '/tmp/of-worktrees/resolved', branch: 'feature/resolved' });
    });

    it('agent can list ten children within the byte budget, each with id, name and state', async () => {
      const directories = await spawnChildren(CHILD_COUNT);

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
      expect(children.map((child: { directory: string }) => child.directory).sort()).toEqual(directories.map((directory) => realpathSync.native(directory)).sort());
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

    it('agent finds where a grandchild it never spawned is running', async () => {
      const [childDirectory] = await spawnChildren(1);
      const childToken = harness.launches.find((launch) => launch.directory === realpathSync.native(childDirectory!))!.mcpToken;
      const childClient = new Client({ name: 'child', version: '0.0.0' });
      await childClient.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${childToken}` } } }));
      const grandchildDirectory = existingWorktreeDir('grandchild');
      await childClient.callTool({ name: 'create_session', arguments: { directory: grandchildDirectory, name: 'Pippin' } });

      const listed = parsed(await call('list_sessions'));

      const grandchild = listed.find((session: { name: string }) => session.name === 'Pippin');
      expect(grandchild.directory).toBe(realpathSync.native(grandchildDirectory));
      await childClient.close();
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

  describe('session tool descriptions', () => {
    const descriptionOf = async (name: string) => (await client.listTools()).tools.find((tool) => tool.name === name)!.description!;

    it.each(['create_session', 'get_session_status', 'list_children', 'list_sessions'])('%s tells the agent it gets a compact session with its directory and no echoed permissionMode', async (name) => {
      const description = await descriptionOf(name);

      expect(description).toMatch(/compact/i);
      expect(description).toContain('emoji, directory, state');
      expect(description).toContain('permissionMode');
    });

    it('list_sessions tells the agent each session carries its parentId while list_children omits it', async () => {
      expect(await descriptionOf('list_sessions')).toContain('parentId');
      expect(await descriptionOf('list_children')).toMatch(/no parentId|without parentId/);
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
      const created = parsed(await call('create_note', { title: 'Plan', body_md: '## H\nold' }));
      expect(keysOf(created)).toEqual(['fileBacked', 'folder', 'id', 'rev', 'shared', 'title']);

      const updated = parsed(await call('update_note', { note: created.id, body_md: '## H\nolder', expected_rev: created.rev }));
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

    describe('get_note with mentions_only', () => {
      it('agent reads the body once plus one block per mention, with no expandedBody', async () => {
        const mentioned = parsed(await call('create_note', { title: 'Target', body_md: 'target body\n\nwith a blank line', shared: true }));
        const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${mentioned.id}` }));

        const note = parsed(await call('get_note', { note: created.id, mentions_only: true }));

        expect(note.bodyMd).toBe(`see @note:${mentioned.id}`);
        expect(note).not.toHaveProperty('expandedBody');
        expect(note.mentionBlocks).toEqual([`--- from note @note:${mentioned.id} (Target, p1) ---\ntarget body\n\nwith a blank line\n--- end @note:${mentioned.id} ---`]);
      });

      it('agent gets the same blocks as the tail of expandedBody in the default shape', async () => {
        const mentioned = parsed(await call('create_note', { title: 'Target', body_md: 'target body', shared: true }));
        const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${mentioned.id}` }));

        const expanded = parsed(await call('get_note', { note: created.id }));
        const mentionsOnly = parsed(await call('get_note', { note: created.id, mentions_only: true }));

        expect(expanded.expandedBody).toBe([expanded.bodyMd, ...mentionsOnly.mentionBlocks].join('\n\n'));
      });

      it('agent sees the not-expanded budget and depth lines among the mention blocks', async () => {
        const huge = parsed(await call('create_note', { title: 'Huge', body_md: 'x'.repeat(70 * 1024), shared: true }));
        const third = parsed(await call('create_note', { title: 'Third', body_md: 'third body', shared: true }));
        const second = parsed(await call('create_note', { title: 'Second', body_md: `then @note:${third.id}`, shared: true }));
        const first = parsed(await call('create_note', { title: 'First', body_md: `then @note:${second.id}`, shared: true }));
        const budgetSource = parsed(await call('create_note', { title: 'BudgetSource', body_md: `see @note:${huge.id}` }));
        const depthSource = parsed(await call('create_note', { title: 'DepthSource', body_md: `see @note:${first.id}` }));

        const budgetCut = parsed(await call('get_note', { note: budgetSource.id, mentions_only: true }));
        const depthCut = parsed(await call('get_note', { note: depthSource.id, mentions_only: true }));

        expect(budgetCut.mentionBlocks).toEqual([`--- @note:${huge.id}: not expanded (budget) ---`]);
        expect(depthCut.mentionBlocks.at(-1)).toBe(`--- @note:${third.id}: not expanded (depth) ---`);
      });

      it('agent gets no mentionBlocks from a note without mentions, and the default shape without the flag', async () => {
        const created = parsed(await call('create_note', { title: 'Plain', body_md: 'just text' }));

        const mentionsOnly = parsed(await call('get_note', { note: created.id, mentions_only: true }));
        const plain = parsed(await call('get_note', { note: created.id }));

        expect(mentionsOnly).not.toHaveProperty('mentionBlocks');
        expect(mentionsOnly).not.toHaveProperty('expandedBody');
        expect(plain).not.toHaveProperty('mentionBlocks');
      });

      it('agent keeps the default shape of a note with mentions when mentions_only is absent or false', async () => {
        const mentioned = parsed(await call('create_note', { title: 'Target', body_md: 'target body', shared: true }));
        const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${mentioned.id}` }));

        const withoutFlag = parsed(await call('get_note', { note: created.id }));
        const withFalse = parsed(await call('get_note', { note: created.id, mentions_only: false }));

        expect(withFalse).toEqual(withoutFlag);
        expect(withoutFlag.expandedBody).toContain('target body');
        expect(withoutFlag).not.toHaveProperty('mentionBlocks');
      });

      it('agent sees mentions_only in the get_note input schema', async () => {
        const { tools } = await client.listTools();
        const getNoteTool = tools.find((tool) => tool.name === 'get_note')!;
        const properties = getNoteTool.inputSchema.properties as Record<string, { type?: string }>;

        expect(properties.mentions_only?.type).toBe('boolean');
        expect(getNoteTool.description).toContain('mentionBlocks');
      });

      it('agent reads in the get_note description that the body still counts against the 64 KiB budget with mentions_only', async () => {
        const { tools } = await client.listTools();
        const getNoteTool = tools.find((tool) => tool.name === 'get_note')!;

        expect(getNoteTool.description).toContain('the body still counts against the 64 KiB budget');
      });
    });

    it('agent sees the mention line and the expanded text of a note whose only mention was cut by the byte budget', async () => {
      const huge = parsed(await call('create_note', { title: 'Huge', body_md: 'x'.repeat(70 * 1024), shared: true }));
      const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${huge.id}` }));

      const note = parsed(await call('get_note', { note: created.id }));

      expect(note.bodyMd).toBe(`see @note:${huge.id}`);
      expect(note.expandedBody).toContain(`@note:${huge.id}: not expanded (budget)`);
    });

    it('agent sees the mention line and the expanded text of a note whose mention chain was cut by the depth limit', async () => {
      const third = parsed(await call('create_note', { title: 'Third', body_md: 'third body', shared: true }));
      const second = parsed(await call('create_note', { title: 'Second', body_md: `then @note:${third.id}`, shared: true }));
      const first = parsed(await call('create_note', { title: 'First', body_md: `then @note:${second.id}`, shared: true }));
      const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${first.id}` }));

      const note = parsed(await call('get_note', { note: created.id }));

      expect(note.expandedBody).toContain(`@note:${third.id}: not expanded (depth)`);
      expect(note.expandedBody).not.toContain('third body');
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

    describe('columnar query format', () => {
      const HUGE_CELL_BYTES = 60 * 1024;
      const HUGE_ROW_COUNT = 30;

      const columnarQuery = (args: Record<string, unknown>) => call('query_data_store', { format: 'columnar', ...args });

      /** Zips the header with each row, so no position is ever counted by hand. */
      const rowObjectsFromColumnar = (columnar: { columns: string[]; rows: unknown[][] }) => columnar.rows.map((cells) => Object.fromEntries(columnar.columns.map((header, index) => [header, cells[index]])));

      /** The row objects of the default format, every cell of `columnIds` present, a missing one as null. */
      const rowsWithEveryCell = (rows: { id: string; data: Record<string, unknown>; updatedAt?: string }[], columnIds: string[]) => rows.map((row) => ({
        id: row.id, updatedAt: row.updatedAt, ...Object.fromEntries(columnIds.map((columnId) => [columnId, row.data[columnId] ?? null])),
      }));

      async function seedMixedTypeTable(rowCount: number) {
        const store = parsed(await call('create_data_store', { display_name: 'mixed' }));
        const addColumn = async (display_name: string, column_type: string, extra: object = {}) => parsed(await call('add_data_store_column', { store: store.id, display_name, column_type, ...extra })).id as string;
        const textId = await addColumn('title', 'text');
        const numberId = await addColumn('points', 'number');
        const dateId = await addColumn('due', 'date');
        const jsonId = await addColumn('extra', 'json');
        const selectId = await addColumn('status', 'select', { options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] });
        const rows = Array.from({ length: rowCount }, (_, index) => ({
          [textId]: index % 3 === 0 ? `héllo wörld 🚀 ${index}` : `plain ${index}`,
          ...(index % 5 === 0 ? {} : { [numberId]: index }),
          [dateId]: '2026-09-30',
          [jsonId]: { nested: [index, null, 'ü'] },
          ...(index % 4 === 0 ? {} : { [selectId]: 'todo' }),
        }));
        if (rowCount > 0) await call('insert_data_store_rows', { store: store.id, rows });
        const columnIds = [textId, numberId, dateId, jsonId, selectId] as [string, string, string, string, string];
        return { storeId: store.id as string, columnIds };
      }

      it('agent can query fifty rows in columnar format within the columnar byte budget, columns named once', async () => {
        const storeId = await seedTable();

        const result = await columnarQuery({ store: storeId, limit: ROW_COUNT });

        expect(isCompactJson(result)).toBe(true);
        expect(bytesOf(result)).toBeLessThanOrEqual(BYTE_BUDGET.queryDataStoreColumnar);
        const { columns, rows, count, truncated } = parsed(result);
        expect(columns).toHaveLength(2 + COLUMN_COUNT);
        expect(columns.slice(0, 2)).toEqual(['id', 'updatedAt']);
        expect(rows).toHaveLength(ROW_COUNT);
        expect(count).toBe(ROW_COUNT);
        expect(truncated).toBe(false);
        for (const row of rows) expect(row).toHaveLength(columns.length);
      });

      it('agent rebuilds exactly the row objects from the columnar header and rows, for every column type, empty cells and unicode', async () => {
        const { storeId, columnIds } = await seedMixedTypeTable(ROW_COUNT);
        const asObjects = parsed(await call('query_data_store', { store: storeId, limit: ROW_COUNT }));

        const columnar = parsed(await columnarQuery({ store: storeId, limit: ROW_COUNT }));

        expect(columnar.rows).toHaveLength(ROW_COUNT);
        expect(rowObjectsFromColumnar(columnar)).toEqual(rowsWithEveryCell(asObjects.rows, columnIds));
        expect(columnar.count).toBe(asObjects.count);
        expect(columnar.truncated).toBe(asObjects.truncated);
      });

      it('agent sees a missing cell as null in columnar while the rows format omits it, and keeps an explicit null as null in both', async () => {
        const { storeId, columnIds: [textId, numberId] } = await seedMixedTypeTable(0);
        await call('insert_data_store_rows', { store: storeId, rows: [{ [textId]: 'missing number' }, { [textId]: 'null number', [numberId]: null }] });

        const asObjects = parsed(await call('query_data_store', { store: storeId, columns: [textId, numberId] }));
        const columnar = parsed(await columnarQuery({ store: storeId, columns: [textId, numberId], include_updated_at: false }));

        expect(asObjects.rows[0].data).toEqual({ [textId]: 'missing number' });
        expect(asObjects.rows[0].data).not.toHaveProperty(numberId);
        expect(columnar.rows.map((cells: unknown[]) => cells.slice(1))).toEqual([['missing number', null], ['null number', null]]);
        expect(asObjects.rows[1].data[numberId] ?? null).toBeNull();
      });

      it('agent gets a header and no rows from a store with no rows in both formats, the header naming id, updatedAt and every column', async () => {
        const { storeId, columnIds } = await seedMixedTypeTable(0);

        const columnar = parsed(await columnarQuery({ store: storeId }));
        const asObjects = parsed(await call('query_data_store', { store: storeId }));

        expect(columnar).toEqual({
          columns: ['id', 'updatedAt', ...columnIds], names: ['id', 'updatedAt', 'title', 'points', 'due', 'extra', 'status'], rows: [], truncated: false, count: 0,
        });
        expect(asObjects).toEqual({ rows: [], truncated: false, count: 0 });
      });

      it('agent selects columns by id or by name, in the order asked, in both formats', async () => {
        const { storeId, columnIds: [textId, numberId] } = await seedMixedTypeTable(3);

        const columnar = parsed(await columnarQuery({ store: storeId, columns: ['points', textId] }));
        const asObjects = parsed(await call('query_data_store', { store: storeId, columns: [textId, 'points'] }));

        expect(columnar.columns).toEqual(['id', 'updatedAt', numberId, textId]);
        for (const row of columnar.rows) expect(row).toHaveLength(columnar.columns.length);
        for (const row of asObjects.rows) expect(Object.keys(row.data).every((key) => [textId, numberId].includes(key))).toBe(true);
        expect(asObjects.rows.some((row: { data: object }) => textId in row.data)).toBe(true);
      });

      it('agent matches a column name whatever its case, in both formats, while ids stay exact', async () => {
        const { storeId, columnIds: [textId, , , , selectId] } = await seedMixedTypeTable(2);

        const columnar = parsed(await columnarQuery({ store: storeId, columns: ['STATUS', 'Title'] }));
        const asObjects = parsed(await call('query_data_store', { store: storeId, columns: ['sTaTuS'] }));
        const wrongCaseId = await columnarQuery({ store: storeId, columns: [selectId.toLowerCase() === selectId ? selectId.toUpperCase() : selectId.toLowerCase()] });

        expect(columnar.columns).toEqual(['id', 'updatedAt', selectId, textId]);
        expect(Object.keys(asObjects.rows[0].data)).toEqual([selectId]);
        expect(wrongCaseId.isError).toBe(true);
      });

      it('agent labels every position of the header with names, whether it asked by name, by id, mixed or with duplicates', async () => {
        const { storeId, columnIds: [textId, numberId] } = await seedMixedTypeTable(1);
        const namedColumnar = (args: Record<string, unknown>) => columnarQuery({ store: storeId, ...args }).then(parsed);

        const byName = await namedColumnar({ columns: ['points', 'title'] });
        const byId = await namedColumnar({ columns: [numberId, textId] });
        const mixed = await namedColumnar({ columns: ['points', textId] });
        const deduplicated = await namedColumnar({ columns: ['Title', textId, 'title', numberId] });
        const withoutUpdatedAt = await namedColumnar({ columns: ['points'], include_updated_at: false });
        const everyColumn = await namedColumnar({});

        for (const columnar of [byName, byId, mixed]) {
          expect(columnar.columns).toEqual(['id', 'updatedAt', numberId, textId]);
          expect(columnar.names).toEqual(['id', 'updatedAt', 'points', 'title']);
        }
        expect(deduplicated.columns).toEqual(['id', 'updatedAt', textId, numberId]);
        expect(deduplicated.names).toEqual(['id', 'updatedAt', 'title', 'points']);
        expect(withoutUpdatedAt.columns).toEqual(['id', numberId]);
        expect(withoutUpdatedAt.names).toEqual(['id', 'points']);
        expect(everyColumn.names).toHaveLength(everyColumn.columns.length);
        expect(everyColumn.names.slice(2)).toEqual(['title', 'points', 'due', 'extra', 'status']);
      });

      it('agent is told which columns it sent are unknown, as columns and not as ids, while where and order_by keep the existing id error', async () => {
        const { storeId } = await seedMixedTypeTable(1);

        const columnar = await columnarQuery({ store: storeId, columns: ['title', 'no such column', 'Nope'] });
        const asObjects = await call('query_data_store', { store: storeId, columns: ['no such column'] });
        const badWhere = await call('query_data_store', { store: storeId, where: [{ columnId: 'Title', op: 'eq', value: 'x' }] });

        expect(columnar.isError).toBe(true);
        expect(rawText(columnar)).toBe('Unknown columns: no such column, Nope');
        expect(asObjects.isError).toBe(true);
        expect(rawText(asObjects)).toBe('Unknown columns: no such column');
        expect(rawText(badWhere)).toBe('Unknown column ids: Title');
      });

      it('agent keeps the existing store error when the store does not exist, with or without the new arguments', async () => {
        const plain = await call('query_data_store', { store: 'nope' });
        const columnar = await columnarQuery({ store: 'nope', columns: ['title'], include_updated_at: false });

        expect(rawText(plain)).toBe('data store not found');
        expect(rawText(columnar)).toBe('data store not found');
      });

      it('agent drops updatedAt from every row in both formats with include_updated_at false and keeps it otherwise', async () => {
        const { storeId } = await seedMixedTypeTable(3);

        const columnarWithout = parsed(await columnarQuery({ store: storeId, include_updated_at: false }));
        const objectsWithout = parsed(await call('query_data_store', { store: storeId, include_updated_at: false }));
        const columnarWith = parsed(await columnarQuery({ store: storeId, include_updated_at: true }));
        const objectsWith = parsed(await call('query_data_store', { store: storeId }));

        expect(columnarWithout.columns.slice(0, 2)).toEqual(['id', columnarWith.columns[2]]);
        expect(columnarWithout.columns).toHaveLength(columnarWith.columns.length - 1);
        expect(columnarWithout.names.slice(0, 2)).toEqual(['id', columnarWith.names[2]]);
        for (const row of columnarWithout.rows) expect(row).toHaveLength(columnarWithout.columns.length);
        for (const row of objectsWithout.rows) expect(keysOf(row)).toEqual(['data', 'id']);
        expect(columnarWith.columns.slice(0, 2)).toEqual(['id', 'updatedAt']);
        for (const row of columnarWith.rows) expect(row).toHaveLength(columnarWith.columns.length);
        for (const row of objectsWith.rows) expect(keysOf(row)).toEqual(['data', 'id', 'updatedAt']);
      });

      it('agent gets the same rows, count and truncation in both formats when the result passes the byte budget', async () => {
        const store = parsed(await call('create_data_store', { display_name: 'huge' }));
        const bodyId = parsed(await call('add_data_store_column', { store: store.id, display_name: 'body', column_type: 'text' })).id;
        for (let index = 0; index < HUGE_ROW_COUNT; index += 1) await call('insert_data_store_rows', { store: store.id, rows: [{ [bodyId]: `${index % 10}`.repeat(HUGE_CELL_BYTES) }] });

        const asObjects = parsed(await call('query_data_store', { store: store.id, limit: HUGE_ROW_COUNT }));
        const columnar = parsed(await columnarQuery({ store: store.id, limit: HUGE_ROW_COUNT }));

        expect(asObjects.truncated).toBe(true);
        expect(columnar.truncated).toBe(true);
        expect(columnar.count).toBe(asObjects.count);
        expect(columnar.rows).toHaveLength(columnar.count);
        expect(columnar.rows.map((row: unknown[]) => row[0])).toEqual(asObjects.rows.map((row: { id: string }) => row.id));
      });

      it('agent keeps every row when the selected columns make the result fit, because rows are projected before truncation', async () => {
        const store = parsed(await call('create_data_store', { display_name: 'huge' }));
        const bodyId = parsed(await call('add_data_store_column', { store: store.id, display_name: 'body', column_type: 'text' })).id;
        const tagId = parsed(await call('add_data_store_column', { store: store.id, display_name: 'tag', column_type: 'text' })).id;
        for (let index = 0; index < HUGE_ROW_COUNT; index += 1) await call('insert_data_store_rows', { store: store.id, rows: [{ [bodyId]: 'x'.repeat(HUGE_CELL_BYTES), [tagId]: `tag ${index}` }] });

        const columnar = parsed(await columnarQuery({ store: store.id, columns: ['tag'], limit: HUGE_ROW_COUNT }));
        const asObjects = parsed(await call('query_data_store', { store: store.id, columns: ['tag'], limit: HUGE_ROW_COUNT }));

        expect(columnar.truncated).toBe(false);
        expect(columnar.count).toBe(HUGE_ROW_COUNT);
        expect(asObjects.truncated).toBe(false);
        expect(asObjects.count).toBe(HUGE_ROW_COUNT);
      });

      describe('serialized result size against the byte budget', () => {
        const ONE_MEBIBYTE = 1024 * 1024;
        const FILLED_ROW_COUNT = 20;

        /** Seeds twenty rows whose whole serialized columnar result is exactly `1 MiB + overshootBytes`. */
        async function seedRowsFillingBudget({ overshootBytes }: { overshootBytes: number }) {
          const store = parsed(await call('create_data_store', { display_name: 'filled' }));
          const bodyId = parsed(await call('add_data_store_column', { store: store.id, display_name: 'body', column_type: 'text' })).id as string;
          const columnarArgs = { store: store.id, include_updated_at: false, limit: FILLED_ROW_COUNT };
          await call('insert_data_store_rows', { store: store.id, rows: Array.from({ length: FILLED_ROW_COUNT }, () => ({ [bodyId]: '' })) });
          const emptyResult = await columnarQuery(columnarArgs);
          const bodyBytesToSpread = ONE_MEBIBYTE + overshootBytes - bytesOf(emptyResult);
          const evenBodyBytes = Math.floor(bodyBytesToSpread / FILLED_ROW_COUNT);
          const lastBodyBytes = bodyBytesToSpread - evenBodyBytes * (FILLED_ROW_COUNT - 1);
          const rowIds = parsed(emptyResult).rows.map((cells: unknown[]) => cells[0]);
          const updates = rowIds.map((rowId: string, index: number) => ({ row_id: rowId, patch: { [bodyId]: 'x'.repeat(index === FILLED_ROW_COUNT - 1 ? lastBodyBytes : evenBodyBytes) } }));
          await call('update_data_store_rows', { store: store.id, updates });
          return columnarArgs;
        }

        it('agent gets every row in a serialized result of exactly the budget', async () => {
          const columnarArgs = await seedRowsFillingBudget({ overshootBytes: 0 });

          const result = await columnarQuery(columnarArgs);

          expect(bytesOf(result)).toBe(ONE_MEBIBYTE);
          expect(parsed(result).truncated).toBe(false);
          expect(parsed(result).count).toBe(FILLED_ROW_COUNT);
        });

        it('agent loses the last row and stays within the budget when the whole result would be one byte past it', async () => {
          const columnarArgs = await seedRowsFillingBudget({ overshootBytes: 1 });

          const result = await columnarQuery(columnarArgs);

          expect(bytesOf(result)).toBeLessThanOrEqual(ONE_MEBIBYTE);
          expect(parsed(result).truncated).toBe(true);
          expect(parsed(result).count).toBe(FILLED_ROW_COUNT - 1);
        });

        it('agent never gets a serialized result past the budget from a table of large rows', async () => {
          const store = parsed(await call('create_data_store', { display_name: 'huge' }));
          const bodyId = parsed(await call('add_data_store_column', { store: store.id, display_name: 'body', column_type: 'text' })).id;
          for (let index = 0; index < HUGE_ROW_COUNT; index += 1) await call('insert_data_store_rows', { store: store.id, rows: [{ [bodyId]: 'y'.repeat(HUGE_CELL_BYTES + index) }] });

          const result = await columnarQuery({ store: store.id, limit: HUGE_ROW_COUNT });

          expect(parsed(result).truncated).toBe(true);
          expect(bytesOf(result)).toBeLessThanOrEqual(ONE_MEBIBYTE);
        });
      });

      it('agent sees the new arguments in the query_data_store input schema and description', async () => {
        const { tools } = await client.listTools();
        const queryTool = tools.find((tool) => tool.name === 'query_data_store')!;
        const properties = queryTool.inputSchema.properties as Record<string, { enum?: string[]; type?: string; items?: unknown }>;

        expect(properties.format?.enum).toEqual(['rows', 'columnar']);
        expect(properties.columns?.type).toBe('array');
        expect(properties.include_updated_at?.type).toBe('boolean');
        expect(queryTool.description).toContain('columnar');
      });

      it('agent reads in the query_data_store description what an empty columns list, names, duplicates and empty cells mean', async () => {
        const { tools } = await client.listTools();
        const description = tools.find((tool) => tool.name === 'query_data_store')!.description!;

        expect(description).toContain('an empty list keeps NO data columns');
        expect(description).toContain('columnar rows are [rowId, updatedAt] or [rowId] with include_updated_at false');
        expect(description).toContain('rows format has data: {}');
        expect(description).toContain('columns lists id, updatedAt (unless dropped) then the data column ids, names labels the same positions');
        expect(description).toContain('where and order_by take column ids only');
        expect(description).toContain('names resolve to ids');
        expect(description).toContain('an id wins over a name');
        expect(description).toContain('duplicates are dropped');
        expect(description).toContain('order is preserved');
        expect(description).toContain('an empty cell is null');
      });
    });

    describe('QE hostile cases: columnar and column selection', () => {
      const columnarQuery = (args: Record<string, unknown>) => call('query_data_store', { format: 'columnar', ...args });

      async function seedThreeColumns() {
        const store = parsed(await call('create_data_store', { display_name: 'trio' }));
        const addText = async (display_name: string) => parsed(await call('add_data_store_column', { store: store.id, display_name, column_type: 'text' })).id as string;
        const alphaId = await addText('alpha');
        const betaId = await addText('beta');
        const gammaId = await addText('gamma');
        await call('insert_data_store_rows', { store: store.id, rows: [{ [alphaId]: 'a1', [betaId]: 'b1', [gammaId]: 'g1' }, { [alphaId]: 'a2', [gammaId]: 'g2' }] });
        return { storeId: store.id as string, alphaId, betaId, gammaId };
      }

      it('agent gets each cell under the column it asked for when columns reorders the selection', async () => {
        const { storeId, alphaId, gammaId } = await seedThreeColumns();

        const columnar = parsed(await columnarQuery({ store: storeId, columns: ['gamma', 'alpha'], include_updated_at: false, order_by: [{ columnId: alphaId, dir: 'asc' }] }));

        expect(columnar.columns).toEqual(['id', gammaId, alphaId]);
        expect(columnar.rows.map((row: unknown[]) => row.slice(1))).toEqual([['g1', 'a1'], ['g2', 'a2']]);
      });

      it('agent gets a column once when it names it twice, by name and by id', async () => {
        const { storeId, alphaId } = await seedThreeColumns();

        const columnar = parsed(await columnarQuery({ store: storeId, columns: ['alpha', alphaId, 'alpha'] }));
        const asObjects = parsed(await call('query_data_store', { store: storeId, columns: ['alpha', alphaId, 'alpha'] }));

        expect(columnar.columns).toEqual(['id', 'updatedAt', alphaId]);
        for (const row of columnar.rows) expect(row).toHaveLength(3);
        expect(Object.keys(asObjects.rows[0].data)).toEqual([alphaId]);
      });

      it('agent reaches the column whose id it names even when another column is displayed under that id', async () => {
        const { storeId, alphaId } = await seedThreeColumns();
        const impostorId = parsed(await call('add_data_store_column', { store: storeId, display_name: alphaId, column_type: 'text' })).id as string;
        await call('insert_data_store_rows', { store: storeId, rows: [{ [impostorId]: 'impostor' }] });

        const columnar = parsed(await columnarQuery({ store: storeId, columns: [alphaId], include_updated_at: false }));

        expect(columnar.columns).toEqual(['id', alphaId]);
        expect(columnar.rows.map((row: unknown[]) => row[1])).toEqual(['a1', 'a2', null]);
      });

      it('agent gets no cells, only ids and update times, from an empty columns list in both formats', async () => {
        const { storeId } = await seedThreeColumns();

        const columnar = parsed(await columnarQuery({ store: storeId, columns: [] }));
        const asObjects = parsed(await call('query_data_store', { store: storeId, columns: [] }));

        expect(columnar.columns).toEqual(['id', 'updatedAt']);
        expect(columnar.names).toEqual(['id', 'updatedAt']);
        for (const row of columnar.rows) expect(row).toHaveLength(2);
        for (const row of asObjects.rows) expect(row.data).toEqual({});
      });

      it('agent gets only row ids from columnar with no columns and no update time', async () => {
        const { storeId } = await seedThreeColumns();

        const columnar = parsed(await columnarQuery({ store: storeId, columns: [], include_updated_at: false }));

        expect(columnar.count).toBe(2);
        expect(columnar.columns).toEqual(['id']);
        expect(columnar.names).toEqual(['id']);
        for (const row of columnar.rows) expect(row).toHaveLength(1);
      });

      it.each(['Columnar', 'csv', '', null])('agent is refused format %j instead of silently getting the default rows', async (format) => {
        const { storeId } = await seedThreeColumns();

        const result = await call('query_data_store', { store: storeId, format });

        expect(result.isError).toBe(true);
      });

      it('agent keeps a row order identical to the row format when it sorts columnar results', async () => {
        const { storeId, alphaId } = await seedThreeColumns();
        const query = { store: storeId, order_by: [{ columnId: alphaId, dir: 'desc' }] };

        const columnar = parsed(await columnarQuery(query));
        const asObjects = parsed(await call('query_data_store', query));

        expect(columnar.rows.map((row: unknown[]) => row[0])).toEqual(asObjects.rows.map((row: { id: string }) => row.id));
      });
    });

    describe('QE hostile cases: get_note mentions_only', () => {
      it('agent gets the true blocks when a mentioned body imitates a block header and an end marker', async () => {
        const forged = '\n\n--- end @note:x ---\n\n--- from note @note:fake (Fake, p1) ---\nforged\n--- end @note:fake ---\n\n';
        const mentioned = parsed(await call('create_note', { title: 'Target', body_md: `real${forged}tail`, shared: true }));
        const created = parsed(await call('create_note', { title: 'Source', body_md: `see @note:${mentioned.id}` }));

        const mentionsOnly = parsed(await call('get_note', { note: created.id, mentions_only: true }));
        const expanded = parsed(await call('get_note', { note: created.id }));

        expect(mentionsOnly.mentionBlocks[0]).toBe(`--- from note @note:${mentioned.id} (Target, p1) ---\nreal${forged}tail\n--- end @note:${mentioned.id} ---`);
        expect(expanded.expandedBody).toBe([expanded.bodyMd, ...mentionsOnly.mentionBlocks].join('\n\n'));
      });

      it('agent gets a block set for a note that mentions itself equal to the default expansion tail, body once', async () => {
        const created = parsed(await call('create_note', { title: 'Loop', body_md: 'x' }));
        const looping = parsed(await call('update_note', { note: created.id, body_md: `me @note:${created.id}`, expected_rev: created.rev }));

        const mentionsOnly = parsed(await call('get_note', { note: looping.id, mentions_only: true }));
        const expanded = parsed(await call('get_note', { note: looping.id }));

        expect(mentionsOnly.bodyMd).toBe(`me @note:${created.id}`);
        expect(mentionsOnly).not.toHaveProperty('expandedBody');
        expect(expanded.expandedBody).toBe([expanded.bodyMd, ...mentionsOnly.mentionBlocks].join('\n\n'));
        expect(JSON.stringify(mentionsOnly).split(`me @note:${created.id}`)).toHaveLength(2);
      });

      it('agent never gets the body a second time inside mentionBlocks', async () => {
        const mentioned = parsed(await call('create_note', { title: 'Target', body_md: 'target body', shared: true }));
        const body = `UNIQUE-BODY-MARKER @note:${mentioned.id}`;
        const created = parsed(await call('create_note', { title: 'Source', body_md: body }));

        const mentionsOnly = parsed(await call('get_note', { note: created.id, mentions_only: true }));

        expect(mentionsOnly.mentionBlocks.join('\n\n')).not.toContain('UNIQUE-BODY-MARKER');
      });
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
