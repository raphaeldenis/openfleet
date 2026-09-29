import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { createMcpHandler } from '../mcp/mcpServer.js';
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
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };
const ONE_MIB = 1024 * 1024;

let server: Awaited<ReturnType<typeof startServer>>;
let docs: DocsFolderService;
let noteRepo: NoteRepository;
let mcpToken: string;
let fileBackedProjectId: string;
let docsFolderPath: string;
let db: DatabaseSync;

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${server.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const createNote = async (overrides: Record<string, unknown> = {}) =>
  (await call('POST', '/api/notes', { projectId: 'p1', title: 'Plan', bodyMd: '## Log\nentry 1', ...overrides })).json() as Promise<Record<string, any>>;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };

  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  fileBackedProjectId = 'p-fb';
  docsFolderPath = mkdtempSync(join(tmpdir(), 'of-docs-'));
  projects.insert({ id: fileBackedProjectId, name: 'FileBacked', docsFolderPath, createdAt: 't0' });

  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId });
  noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId });
  docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });
  docs.ensureLayout(docsFolderPath);

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    notes, noteRepo, docs, stores, storeRepo, projects,
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs }),
  });

  const session = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', session.id);
  mcpToken = harness.launches[0]!.mcpToken;
});
afterEach(() => server.close());

describe('notes REST routes', () => {
  it('refuses every registered /api route without the admin token', async () => {
    const apiRoutes = server.routes.filter(({ path }) => path.startsWith('/api/'));

    const answers = await Promise.all(apiRoutes.flatMap(({ method, path }) => {
      const concretePath = path.replace(/:\w+/g, 'x');
      const body = method === 'GET' ? undefined : {};
      return [
        call(method, concretePath, body, { 'content-type': 'application/json' }).then((response) => ({ method, path, status: response.status })),
        call(method, concretePath, body, { authorization: 'Bearer wrong', 'content-type': 'application/json' }).then((response) => ({ method, path, status: response.status })),
      ];
    }));

    expect(apiRoutes.length).toBeGreaterThan(15);
    expect(answers.filter(({ status }) => status !== 401)).toEqual([]);
    expect(apiRoutes.map(({ path }) => path)).toEqual(expect.arrayContaining(['/api/notes/:id/restore', '/api/data-stores/:id/rows/:rowId/changes', '/api/projects']));
  });

  describe('user can list the projects', () => {
    it('lists every project with its docs folder path, in creation order', async () => {
      const response = await call('GET', '/api/projects');
      const page = await response.json() as { items: Record<string, unknown>[]; total: number };

      expect(response.status).toBe(200);
      expect(page.items.map((p) => p.id)).toEqual(['p1', 'p2', 'p-fb']);
      expect(page.items[0]).toEqual({ id: 'p1', name: 'One', docsFolderPath: null });
      expect(typeof page.items[2]!.docsFolderPath).toBe('string');
      expect(page).toMatchObject({ total: 3, limit: 100, offset: 0 });
    });

    it('bounds the list by limit and offset and refuses a limit over 200', async () => {
      const page = await (await call('GET', '/api/projects?limit=1&offset=1')).json() as { items: { id: string }[]; total: number };
      const tooMany = await call('GET', '/api/projects?limit=201');

      expect(page.items.map((p) => p.id)).toEqual(['p2']);
      expect(page.total).toBe(3);
      expect(tooMany.status).toBe(400);
    });
  });

  it('hides another project\'s note behind 404 on every :id route', async () => {
    const note = await createNote();
    const foreignRoutes = [
      call('GET', `/api/notes/${note.id}?projectId=p2`),
      call('PATCH', `/api/notes/${note.id}`, { projectId: 'p2', expectedRev: 1, bodyMd: 'x' }),
      call('GET', `/api/notes/${note.id}/versions?projectId=p2`),
      call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p2', rev: 1, expectedRev: 1 }),
    ];

    const statuses = (await Promise.all(foreignRoutes)).map((response) => response.status);

    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  describe('user can create and read a note', () => {
    it('creates a note that reads back with the same view', async () => {
      const created = await call('POST', '/api/notes', { projectId: 'p1', title: 'Plan', bodyMd: 'hello', folder: 'specs', shared: true });
      const createdNote = await created.json() as Record<string, unknown>;

      const read = await call('GET', `/api/notes/${createdNote.id}?projectId=p1`);

      expect(created.status).toBe(201);
      expect(createdNote).toMatchObject({ title: 'Plan', bodyMd: 'hello', folder: 'specs', shared: true, rev: 1, projectId: 'p1', fileBacked: false });
      expect(createdNote).not.toHaveProperty('filePath');
      expect(createdNote).not.toHaveProperty('sourceHash');
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(createdNote);
    });

    it('caps the title at 512 characters on create and on rename', async () => {
      const note = await createNote();

      const createTooLong = await call('POST', '/api/notes', { projectId: 'p1', title: 't'.repeat(513), bodyMd: '' });
      const createAtLimit = await call('POST', '/api/notes', { projectId: 'p1', title: 't'.repeat(512), bodyMd: '' });
      const renameTooLong = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 't'.repeat(513) });

      expect(createTooLong.status).toBe(400);
      expect(createAtLimit.status).toBe(201);
      expect(renameTooLong.status).toBe(400);
    });

    it.each(['', '%20', '-1', '1.5', 'abc'])('refuses limit=%j on the list, the search and the versions with 400', async (limit) => {
      const note = await createNote();

      const statuses = (await Promise.all([
        call('GET', `/api/notes?projectId=p1&limit=${limit}`),
        call('GET', `/api/notes/search?projectId=p1&q=a&limit=${limit}`),
        call('GET', `/api/notes/${note.id}/versions?projectId=p1&limit=${limit}`),
      ])).map((response) => response.status);

      expect(statuses).toEqual([400, 400, 400]);
    });

    it('bounds the search by limit', async () => {
      await createNote({ bodyMd: 'zebra one' });
      await createNote({ bodyMd: 'zebra two' });

      const one = await (await call('GET', '/api/notes/search?projectId=p1&q=zebra&limit=1')).json() as { items: unknown[] };
      const tooMany = await call('GET', '/api/notes/search?projectId=p1&q=zebra&limit=51');

      expect(one.items).toHaveLength(1);
      expect(tooMany.status).toBe(400);
    });

    it('rejects a note without a title with 400', async () => {
      const response = await call('POST', '/api/notes', { projectId: 'p1', title: '', bodyMd: 'x' });

      expect(response.status).toBe(400);
    });

    it('answers 404 project_not_found when the project does not exist', async () => {
      const response = await call('POST', '/api/notes', { projectId: 'ghost', title: 'T', bodyMd: '' });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'project_not_found' });
    });

    it('rejects a note body over 1 MiB with 413', async () => {
      const response = await call('POST', '/api/notes', { projectId: 'p1', title: 'Big', bodyMd: 'x'.repeat(ONE_MIB + 1) });

      expect(response.status).toBe(413);
    });

    it('answers 404 for a missing note and for another project\'s note alike', async () => {
      const note = await createNote();

      const foreign = await call('GET', `/api/notes/${note.id}?projectId=p2`);
      const missing = await call('GET', '/api/notes/nope?projectId=p2');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
    });

    it('requires the project scope', async () => {
      const response = await call('GET', '/api/notes/anything');

      expect(response.status).toBe(400);
    });

    it('returns what the MCP get_note tool returns for the same note', async () => {
      const note = await createNote();
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));

      const viaMcp = JSON.parse(((await client.callTool({ name: 'get_note', arguments: { note: note.id } })) as { content: { text: string }[] }).content[0]!.text);
      const { expandedBody, ...mcpView } = viaMcp;

      expect(expandedBody).toBe(note.bodyMd);
      expect(mcpView).toEqual(note);
    });
  });

  describe('the note reads stay bounded in SQL', () => {
    /** The SQL text of every statement the daemon prepares while serving `path`. */
    const sqlServing = async (path: string) => {
      const prepared: string[] = [];
      const realPrepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => { prepared.push(sql); return realPrepare(sql); });
      const response = await call('GET', path);
      spy.mockRestore();
      return { response, prepared };
    };
    const readsBodies = (sql: string) => /body_md|SELECT\s+\*|\bn\.\*/i.test(sql.replace(/snippet\([^)]*\)/i, ''));

    it('lists a page and never reads a body', async () => {
      const { response, prepared } = await sqlServing('/api/notes?projectId=p1&folder=specs&limit=10&offset=5');

      const noteQueries = prepared.filter((sql) => /FROM notes/i.test(sql));
      expect(response.status).toBe(200);
      expect(noteQueries.length).toBeGreaterThan(0);
      expect(noteQueries.some(readsBodies)).toBe(false);
    });

    it('answers limit=0 with the total and no items', async () => {
      await createNote();

      const { response } = await sqlServing('/api/notes?projectId=p1&limit=0');

      expect(await response.json()).toMatchObject({ items: [], total: 1 });
    });

    it('searches and never reads a body', async () => {
      const { prepared } = await sqlServing('/api/notes/search?projectId=p1&q=zebra');

      const searches = prepared.filter((sql) => /note_fts/i.test(sql));
      expect(searches).toHaveLength(1);
      expect(readsBodies(searches[0]!)).toBe(false);
    });

    it('lists versions and never reads a body', async () => {
      const note = await createNote();

      const { prepared } = await sqlServing(`/api/notes/${note.id}/versions?projectId=p1`);

      const versionQueries = prepared.filter((sql) => /FROM note_versions/i.test(sql) && !/COUNT\(\*\)/i.test(sql));
      expect(versionQueries).toHaveLength(1);
      expect(readsBodies(versionQueries[0]!)).toBe(false);
    });
  });

  describe('user can list and search notes', () => {
    it('lists summaries without bodies, filtered by folder, scoped to the project', async () => {
      await createNote({ title: 'Spec', folder: 'specs' });
      await createNote({ title: 'Report', folder: 'reports' });
      await createNote({ projectId: 'p2', title: 'Elsewhere' });

      const all = await (await call('GET', '/api/notes?projectId=p1')).json() as { items: Record<string, unknown>[]; total: number };
      const specs = await (await call('GET', '/api/notes?projectId=p1&folder=specs')).json() as { items: Record<string, unknown>[]; total: number };

      expect(all.items.map((n) => n.title).sort()).toEqual(['Report', 'Spec']);
      expect(all.total).toBe(2);
      expect(all.items[0]).not.toHaveProperty('bodyMd');
      expect(specs.items.map((n) => n.title)).toEqual(['Spec']);
    });

    it('bounds a list by limit and offset and caps limit at 200', async () => {
      for (const title of ['a', 'b', 'c']) await createNote({ title });

      const everything = await (await call('GET', '/api/notes?projectId=p1')).json() as { items: unknown[] };
      const page = await (await call('GET', '/api/notes?projectId=p1&limit=2&offset=1')).json() as { items: unknown[]; total: number; limit: number; offset: number };
      const tooMany = await call('GET', '/api/notes?projectId=p1&limit=201');

      expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
      expect(page.items).toEqual(everything.items.slice(1, 3));
      expect(tooMany.status).toBe(400);
    });

    it('rejects an unknown folder with 400', async () => {
      const response = await call('GET', '/api/notes?projectId=p1&folder=secrets');

      expect(response.status).toBe(400);
    });

    it('finds a note by a word of its body, with a snippet and no full body', async () => {
      await createNote({ title: 'Recipes', bodyMd: 'the quokka stew is secret' });
      await createNote({ projectId: 'p2', title: 'Other', bodyMd: 'quokka elsewhere' });

      const response = await call('GET', '/api/notes/search?projectId=p1&q=quokka');
      const { items } = await response.json() as { items: Record<string, unknown>[] };

      expect(response.status).toBe(200);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ title: 'Recipes' });
      expect(typeof items[0]!.snippet).toBe('string');
      expect(items[0]).not.toHaveProperty('bodyMd');
    });

    it('answers a blank query with no results and an over-long query with 400', async () => {
      const blank = await (await call('GET', '/api/notes/search?projectId=p1&q=%20')).json();
      const tooLong = await call('GET', `/api/notes/search?projectId=p1&q=${'a'.repeat(513)}`);
      const tooManyTerms = await call('GET', `/api/notes/search?projectId=p1&q=${Array(17).fill('a').join('+')}`);

      expect(blank).toEqual({ items: [], total: 0 });
      expect(tooLong.status).toBe(400);
      expect(tooManyTerms.status).toBe(400);
    });
  });

  describe('user can edit a note with its revision', () => {
    it('updates the body and bumps the revision, recording a version authored "You"', async () => {
      const note = await createNote();

      const response = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'new body' });
      const updated = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(updated).toMatchObject({ bodyMd: 'new body', rev: 2 });
      expect(noteRepo.listVersionSummaries(note.id as string).map((v) => v.author)).toEqual(['You', 'You']);
    });

    it('renames the note with the revision', async () => {
      const note = await createNote();

      const response = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'Renamed' });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ title: 'Renamed', bodyMd: note.bodyMd, rev: 2 });
    });

    it('applies title and body together', async () => {
      const note = await createNote();

      const response = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'Both', bodyMd: 'both body' });

      expect(await response.json()).toMatchObject({ title: 'Both', bodyMd: 'both body' });
    });

    it('commits a title-and-body patch as one revision with one version', async () => {
      const note = await createNote();

      const response = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'Both', bodyMd: 'both body' });

      expect(await response.json()).toMatchObject({ title: 'Both', bodyMd: 'both body', rev: 2 });
      expect(noteRepo.listVersionSummaries(note.id as string).map((v) => v.rev)).toEqual([1, 2]);
    });

    it('leaves title, body and revision unchanged when recording the version of a title-and-body patch fails', async () => {
      const note = await createNote();
      vi.spyOn(noteRepo, 'insertVersion').mockImplementation(() => { throw new Error('disk full'); });

      const failed = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'Both', bodyMd: 'both body' });
      vi.restoreAllMocks();
      const unchanged = await (await call('GET', `/api/notes/${note.id}?projectId=p1`)).json();

      expect(failed.status).toBe(500);
      expect(unchanged).toMatchObject({ title: 'Plan', bodyMd: note.bodyMd, rev: 1 });
    });

    it('answers 409 with the current revision when the revision is stale and leaves the note alone', async () => {
      const note = await createNote();
      await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'first' });

      const stale = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'second' });
      const current = await (await call('GET', `/api/notes/${note.id}?projectId=p1`)).json();

      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: 'stale_revision', currentRev: 2 });
      expect(current).toMatchObject({ bodyMd: 'first', rev: 2 });
    });

    it('rejects a patch with neither title nor body, or without a revision, with 400', async () => {
      const note = await createNote();

      const empty = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1 });
      const noRev = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', bodyMd: 'x' });

      expect(empty.status).toBe(400);
      expect(noRev.status).toBe(400);
    });

    it('answers 404 when patching a missing or foreign note', async () => {
      const note = await createNote();

      const foreign = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p2', expectedRev: 1, bodyMd: 'x' });
      const missing = await call('PATCH', '/api/notes/nope', { projectId: 'p1', expectedRev: 1, bodyMd: 'x' });

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
    });

    it('answers 413 when the new body is over 1 MiB', async () => {
      const note = await createNote();

      const response = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'x'.repeat(ONE_MIB + 1) });

      expect(response.status).toBe(413);
    });

    it('writes a file-backed note through the docs folder and refuses to rename it with 409', async () => {
      const fileBacked = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });

      const edited = await call('PATCH', `/api/notes/${fileBacked.id}`, { projectId: fileBackedProjectId, expectedRev: 1, bodyMd: 'v2' });
      const renamed = await call('PATCH', `/api/notes/${fileBacked.id}`, { projectId: fileBackedProjectId, expectedRev: 2, title: 'nope' });

      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ bodyMd: 'v2', rev: 2, fileBacked: true });
      expect(renamed.status).toBe(409);
      expect(await renamed.json()).toMatchObject({ error: 'file_backed' });
    });
  });

  describe('user editing a file-backed note whose docs folder moved on disk', () => {
    const seedFileBackedNote = () => docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });
    const readNoteVersionRevs = (noteId: string) => noteRepo.listVersionSummaries(noteId).map((version) => version.rev);

    it.each([
      ['the whole docs folder is renamed', () => docsFolderPath],
      ['the note subfolder is renamed', () => join(docsFolderPath, 'specs')],
    ])('gets 409 file_unreadable and no new revision when %s', async (_situation, folderToMove) => {
      const note = seedFileBackedNote();
      renameSync(folderToMove(), `${folderToMove()}-moved`);

      const patched = await call('PATCH', `/api/notes/${note.id}`, { projectId: fileBackedProjectId, expectedRev: 1, bodyMd: 'v2' });
      const restored = await call('POST', `/api/notes/${note.id}/restore`, { projectId: fileBackedProjectId, rev: 1, expectedRev: 1 });

      expect(patched.status).toBe(409);
      expect(await patched.json()).toEqual({ error: 'file_unreadable' });
      expect(restored.status).toBe(409);
      expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
      expect(readNoteVersionRevs(note.id)).toEqual([1]);
    });

    it('keeps the old body, revision and version list when the file swap fails after the body was staged', async () => {
      const note = seedFileBackedNote();
      vi.spyOn(nodeDocsFolderFs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); });

      const patched = await call('PATCH', `/api/notes/${note.id}`, { projectId: fileBackedProjectId, expectedRev: 1, bodyMd: 'v2' });
      vi.restoreAllMocks();

      expect(patched.status).toBe(409);
      expect(await patched.json()).toEqual({ error: 'file_unreadable' });
      expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
      expect(readNoteVersionRevs(note.id)).toEqual([1]);
      expect(readFileSync(noteRepo.get(note.id)!.filePath!, 'utf8')).toBe('v1');
    });
  });

  describe('file-backed notes stay path-free', () => {
    it('never shows the file path or the source hash on the read or the edit of a file-backed note', async () => {
      const fileBacked = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });

      const read = await (await call('GET', `/api/notes/${fileBacked.id}?projectId=${fileBackedProjectId}`)).json() as Record<string, unknown>;
      const edited = await (await call('PATCH', `/api/notes/${fileBacked.id}`, { projectId: fileBackedProjectId, expectedRev: 1, bodyMd: 'v2' })).json() as Record<string, unknown>;

      expect(read).toMatchObject({ fileBacked: true });
      for (const view of [read, edited]) {
        expect(view).not.toHaveProperty('filePath');
        expect(view).not.toHaveProperty('sourceHash');
      }
    });
  });

  describe('search and body limits', () => {
    it('escapes a double quote in the query instead of failing', async () => {
      await createNote({ bodyMd: 'she said "hello" loudly' });

      const response = await call('GET', `/api/notes/search?projectId=p1&q=${encodeURIComponent('say "hel')}`);

      expect(response.status).toBe(200);
    });

    it('returns at most 50 hits when more notes match', async () => {
      const insert = db.prepare(`INSERT INTO notes (id, project_id, title, body_md, folder, file_path, source_hash, rev, shared, created_at, updated_at)
        VALUES (?, 'p1', 'n', 'zebra', NULL, NULL, NULL, 1, 0, 't', 't')`);
      for (let index = 0; index < 51; index++) insert.run(`zebra-${index}`);

      const { items } = await (await call('GET', '/api/notes/search?projectId=p1&q=zebra')).json() as { items: unknown[] };

      expect(items).toHaveLength(50);
    });

    it('refuses a request over 1 MiB with 413 payload_too_large even when the note body itself is under the cap', async () => {
      const bodyUnderNoteCap = 'x'.repeat(ONE_MIB - 1000);

      const response = await call('POST', '/api/notes', { projectId: 'p1', title: 'Big', bodyMd: bodyUnderNoteCap, padding: 'p'.repeat(2000) });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'payload_too_large' });
    });
  });

  describe('request parsing', () => {
    it('keeps a literal question mark of the query and every parameter after it', async () => {
      await createNote({ title: 'Why', bodyMd: 'why is it so' });
      await createNote({ title: 'Why again', bodyMd: 'why not' });

      const response = await call('GET', '/api/notes/search?projectId=p1&q=why%3F&limit=1');
      const rawQuestionMark = await call('GET', '/api/notes/search?projectId=p1&q=why?&limit=1');

      expect(response.status).toBe(200);
      expect(rawQuestionMark.status).toBe(200);
      expect((await rawQuestionMark.json() as { items: unknown[] }).items).toHaveLength(1);
    });

    it.each(['/api/notes/%E0%A4%A?projectId=p1', '/api/data-stores/%E0%A4%A?projectId=p1'])('answers a malformed percent-escape in %s with 404, signed in or not', async (path) => {
      const unauthenticated = await call('GET', path, undefined, {});
      const authenticated = await call('GET', path);

      expect(unauthenticated.status).toBe(404);
      expect(authenticated.status).toBe(404);
    });
  });

  describe('errors never leak paths', () => {
    it('answers 409 path_escapes_docs_folder, without the path, when the note file now points outside the docs folder', async () => {
      const fileBacked = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });
      const outsideDir = mkdtempSync(join(tmpdir(), 'of-outside-'));
      const outsideFile = join(outsideDir, 'secret.md');
      writeFileSync(outsideFile, 'v1');
      const filePath = noteRepo.get(fileBacked.id)!.filePath!;
      unlinkSync(filePath);
      symlinkSync(outsideFile, filePath);

      const response = await call('PATCH', `/api/notes/${fileBacked.id}`, { projectId: fileBackedProjectId, expectedRev: 1, bodyMd: 'v2' });
      const text = await response.text();

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toEqual({ error: 'path_escapes_docs_folder' });
      expect(text).not.toContain(outsideDir);
      expect(text).not.toContain(filePath);
    });

    it('answers an unexpected failure with a bare 500 internal_error carrying no message', async () => {
      const note = await createNote();
      vi.spyOn(noteRepo, 'get').mockImplementation(() => { throw new Error("EACCES: permission denied, open '/Users/secret/docs/plan.md'"); });

      const response = await call('GET', `/api/notes/${note.id}?projectId=p1`);
      const text = await response.text();
      vi.restoreAllMocks();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
    });
  });

  it('refuses a title-and-body patch of a file-backed note before writing anything', async () => {
    const fileBacked = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });

    const refused = await call('PATCH', `/api/notes/${fileBacked.id}`, { projectId: fileBackedProjectId, expectedRev: 1, title: 'nope', bodyMd: 'v2' });
    const unchanged = await (await call('GET', `/api/notes/${fileBacked.id}?projectId=${fileBackedProjectId}`)).json();

    expect(refused.status).toBe(409);
    expect(unchanged).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  describe('user can browse and restore versions', () => {
    it('lists the revision history without bodies', async () => {
      const note = await createNote();
      await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'second' });

      const response = await call('GET', `/api/notes/${note.id}/versions?projectId=p1`);
      const { items } = await response.json() as { items: Record<string, unknown>[] };

      expect(response.status).toBe(200);
      expect(items.map((v) => v.rev)).toEqual([1, 2]);
      expect(items[0]).toMatchObject({ author: 'You' });
      expect(items[0]).not.toHaveProperty('bodyMd');
    });

    it('bounds the history by limit and offset, counting every version, default 100 and max 200', async () => {
      const note = await createNote();
      const insertVersion = db.prepare(`INSERT INTO note_versions (id, note_id, rev, body_md, author, change_summary, created_at) VALUES (?, ?, ?, '', 'You', NULL, 't')`);
      for (let rev = 2; rev <= 250; rev++) insertVersion.run(`v-${rev}`, note.id, rev);

      const byDefault = await (await call('GET', `/api/notes/${note.id}/versions?projectId=p1`)).json() as { items: { rev: number }[]; total: number; limit: number };
      const paged = await (await call('GET', `/api/notes/${note.id}/versions?projectId=p1&limit=3&offset=10`)).json() as { items: { rev: number }[]; total: number };
      const tooMany = await call('GET', `/api/notes/${note.id}/versions?projectId=p1&limit=201`);

      expect(byDefault.items).toHaveLength(100);
      expect(byDefault).toMatchObject({ total: 250, limit: 100 });
      expect(paged.items.map((v) => v.rev)).toEqual([11, 12, 13]);
      expect(tooMany.status).toBe(400);
    });

    it('answers 404 for the versions of a foreign note', async () => {
      const note = await createNote();

      const response = await call('GET', `/api/notes/${note.id}/versions?projectId=p2`);

      expect(response.status).toBe(404);
    });

    it('restores a past revision as a new forward revision', async () => {
      const note = await createNote({ bodyMd: 'original' });
      await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'changed' });

      const response = await call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p1', rev: 1, expectedRev: 2 });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ bodyMd: 'original', rev: 3 });
    });

    it('answers 404 for an unknown revision and 409 when expectedRev is stale', async () => {
      const note = await createNote();

      const unknownRev = await call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p1', rev: 99, expectedRev: 1 });
      const stale = await call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p1', rev: 1, expectedRev: 7 });

      expect(unknownRev.status).toBe(404);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: 'stale_revision', currentRev: 1 });
    });

    it('rejects a restore without a revision or without the expected revision with 400', async () => {
      const note = await createNote();

      const noRev = await call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p1', expectedRev: 1 });
      const noExpectedRev = await call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p1', rev: 1 });
      const unchanged = await (await call('GET', `/api/notes/${note.id}?projectId=p1`)).json();

      expect(noRev.status).toBe(400);
      expect(noExpectedRev.status).toBe(400);
      expect(unchanged).toMatchObject({ rev: 1 });
    });
  });

  it('user can create a note, edit it, hit a stale edit, see the versions and restore', async () => {
    const created = await createNote({ bodyMd: 'v1' });
    const edited = await (await call('PATCH', `/api/notes/${created.id}`, { projectId: 'p1', expectedRev: created.rev, bodyMd: 'v2' })).json() as Record<string, unknown>;
    const stale = await call('PATCH', `/api/notes/${created.id}`, { projectId: 'p1', expectedRev: created.rev, bodyMd: 'lost' });
    const versions = await (await call('GET', `/api/notes/${created.id}/versions?projectId=p1`)).json() as { items: { rev: number }[] };
    const restored = await (await call('POST', `/api/notes/${created.id}/restore`, { projectId: 'p1', rev: 1, expectedRev: edited.rev })).json();

    expect(edited).toMatchObject({ bodyMd: 'v2', rev: 2 });
    expect(stale.status).toBe(409);
    expect(versions.items.map((v) => v.rev)).toEqual([1, 2]);
    expect(restored).toMatchObject({ bodyMd: 'v1', rev: 3 });
  });
});
