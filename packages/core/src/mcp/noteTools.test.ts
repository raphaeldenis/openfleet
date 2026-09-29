import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
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
let noteRepo: NoteRepository;
let docs: DocsFolderService;
let scopedToken: string;
let otherToken: string;
let unscopedToken: string;
let fileBackedToken: string;
let fileBackedProjectId: string;
let docsFolderPath: string;

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
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs }),
  });

  const scoped = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  assignProject(scoped.id, 'p1');
  const other = await sessions.create({ directory: '/tmp', name: 'Legolas', harness: 'fake', emoji: '🏹' });
  assignProject(other.id, 'p2');
  await sessions.create({ directory: '/tmp', name: 'Rootless', harness: 'fake', emoji: '👤' });
  const fileBacked = await sessions.create({ directory: '/tmp', name: 'Frodo', harness: 'fake', emoji: '💍' });
  assignProject(fileBacked.id, fileBackedProjectId);
  scopedToken = harness.launches[0]!.mcpToken;
  otherToken = harness.launches[1]!.mcpToken;
  unscopedToken = harness.launches[2]!.mcpToken;
  fileBackedToken = harness.launches[3]!.mcpToken;
});
afterEach(() => server.close());

async function createNote(client: Client, overrides: Partial<{ title: string; body_md: string; folder: string; shared: boolean }> = {}) {
  return text(await client.callTool({ name: 'create_note', arguments: { title: 'Untitled', body_md: 'body', ...overrides } }));
}

describe('note tools', () => {
  it('lists the note tools', async () => {
    const client = await connect(scopedToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['create_note', 'get_note', 'update_note', 'delete_note', 'move_note', 'list_notes', 'search_notes']),
    );
  });

  it('refuses every note tool for a session with no project', async () => {
    const client = await connect(unscopedToken);
    const result = await client.callTool({ name: 'create_note', arguments: { title: 'x', body_md: 'y' } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/no project/i);
  });

  describe('create_note', () => {
    it('scopes the new note to the caller\'s own project, defaulting folder to null and shared to false', async () => {
      const client = await connect(scopedToken);
      const created = await createNote(client, { title: 'Design doc', body_md: '# v1' });
      expect(created).toMatchObject({ projectId: 'p1', title: 'Design doc', bodyMd: '# v1', folder: null, shared: false, rev: 1 });
    });

    it.each([['a whitespace-only title', '   '], ['a title over 512 characters', 'x'.repeat(513)]])('refuses %s like the REST route does', async (_case, title) => {
      const client = await connect(scopedToken);

      const result = await client.callTool({ name: 'create_note', arguments: { title, body_md: 'body' } });

      expect(result.isError).toBe(true);
    });

    it('trims the title it stores', async () => {
      const client = await connect(scopedToken);

      const created = await createNote(client, { title: '  Design doc  ' });

      expect(created).toMatchObject({ title: 'Design doc' });
    });

    it('honors an explicit folder and shared flag', async () => {
      const client = await connect(scopedToken);
      const created = await createNote(client, { folder: 'specs', shared: true });
      expect(created).toMatchObject({ folder: 'specs', shared: true });
    });
  });

  describe('get_note', () => {
    it('appends expanded mentions after the body', async () => {
      const client = await connect(scopedToken);
      const mentioned = await createNote(client, { title: 'Mentioned', body_md: 'inner body' });
      const root = await createNote(client, { title: 'Root', body_md: `see @note:${mentioned.id}` });

      const fetched = text(await client.callTool({ name: 'get_note', arguments: { note: root.id } }));

      expect(fetched.bodyMd).toBe(`see @note:${mentioned.id}`);
      expect(fetched.expandedBody).toContain('inner body');
      expect(fetched.expandedBody).toContain(`@note:${mentioned.id}`);
    });

    it('never exposes filePath or sourceHash; a plain note is fileBacked false', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client);

      const fetched = text(await client.callTool({ name: 'get_note', arguments: { note: note.id } }));

      expect(fetched).toMatchObject({ fileBacked: false, docsRelativePath: null });
      expect(fetched).not.toHaveProperty('filePath');
      expect(fetched).not.toHaveProperty('sourceHash');
    });

    it('a file-backed note reports fileBacked true and its path relative to the docs folder', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'daemon-protocol', bodyMd: '# v1', author: 'seed' });
      const client = await connect(fileBackedToken);

      const fetched = text(await client.callTool({ name: 'get_note', arguments: { note: note.id } }));

      expect(fetched).toMatchObject({ fileBacked: true, docsRelativePath: 'specs/2026-01-01-daemon-protocol.md' });
      expect(fetched).not.toHaveProperty('filePath');
      expect(fetched).not.toHaveProperty('sourceHash');
    });

    it('a session cannot get_note across a project boundary — a foreign note reads exactly like a missing one', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'get_note', arguments: { note: note.id } });
      const missingResult = await stranger.callTool({ name: 'get_note', arguments: { note: 'does-not-exist' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
      expect(errorText(strangerResult)).not.toContain(note.id);
    });
  });

  describe('update_note', () => {
    it('on a stale rev returns a non-throwing error result with the current rev', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: 'v1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });

      const result = await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v3-stale', expected_rev: note.rev } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toBe('409 stale_revision, current rev: 2');
    });

    it('writes through to disk for a file-backed note, keeping source_hash in sync (Review Focus 5)', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'daemon-protocol', bodyMd: '# v1', author: 'seed' });
      const client = await connect(fileBackedToken);

      const updated = text(await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: '# v2', expected_rev: note.rev } }));

      expect(updated.bodyMd).toBe('# v2');
      const onDisk = nodeDocsFolderFs.readFileSync(note.filePath!);
      expect(onDisk).toBe('# v2');
      expect(updated).not.toHaveProperty('sourceHash');
      expect(noteRepo.get(note.id)!.sourceHash).toBeTruthy();
    });

    it('a disk edit nobody reconciled is kept as a new "disk" revision and the caller is refused with the new rev', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'edited-outside', bodyMd: '# v1', author: 'seed' });
      writeFileSync(note.filePath!, '# edited on disk');
      const client = await connect(fileBackedToken);

      const result = await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: '# agent write', expected_rev: note.rev } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toBe('409 stale_revision, current rev: 2');
      expect(readFileSync(note.filePath!, 'utf8')).toBe('# edited on disk');
      expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: '# edited on disk', rev: 2 });
      expect(noteRepo.listVersions(note.id).map((version) => version.author)).toEqual(['seed', 'disk']);
    });

    it('a note whose file escaped the docs folder fails opaquely, leaking no path', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'escapee', bodyMd: '# v1', author: 'seed' });
      const outsideFolder = mkdtempSync(join(tmpdir(), 'of-outside-'));
      db.prepare('UPDATE notes SET file_path = ? WHERE id = ?').run(join(outsideFolder, 'x.md'), note.id);
      const client = await connect(fileBackedToken);

      const result = await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: '# v2', expected_rev: note.rev } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toBe('request failed');
    });

    it('an oversized body is refused with the limit named', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client);

      const halfTheCap = 'a'.repeat(600 * 1024);
      await client.callTool({ name: 'append_to_note', arguments: { note: note.id, content: halfTheCap } });

      const result = await client.callTool({ name: 'append_to_note', arguments: { note: note.id, content: halfTheCap } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/over the 1048576-byte cap/);
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'hacked', expected_rev: note.rev } });
      const missingResult = await stranger.callTool({ name: 'update_note', arguments: { note: 'does-not-exist', body_md: 'hacked', expected_rev: 1 } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });
  });

  describe('delete_note', () => {
    it('deletes a plain note', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client);

      const result = await client.callTool({ name: 'delete_note', arguments: { note: note.id } });

      expect(result.isError).toBeFalsy();
      const listed = text(await client.callTool({ name: 'list_notes', arguments: {} }));
      expect(listed.notes).toHaveLength(0);
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'delete_note', arguments: { note: note.id } });
      const missingResult = await stranger.callTool({ name: 'delete_note', arguments: { note: 'does-not-exist' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('refuses a file-backed note clearly instead of orphaning its file', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'keep-me', bodyMd: '# v1', author: 'seed' });
      const client = await connect(fileBackedToken);

      const result = await client.callTool({ name: 'delete_note', arguments: { note: note.id } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/file-backed/);
      expect(noteRepo.get(note.id)).toBeDefined();
    });
  });

  describe('move_note', () => {
    it('moves a plain note to a folder, and back to root with null', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client);

      const moved = text(await client.callTool({ name: 'move_note', arguments: { note: note.id, folder: 'plans' } }));
      expect(moved.folder).toBe('plans');

      const movedBack = text(await client.callTool({ name: 'move_note', arguments: { note: note.id, folder: null } }));
      expect(movedBack.folder).toBeNull();
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'move_note', arguments: { note: note.id, folder: 'plans' } });
      const missingResult = await stranger.callTool({ name: 'move_note', arguments: { note: 'does-not-exist', folder: 'plans' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('refuses a file-backed note clearly, since its folder is fixed by its file path', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'fixed-folder', bodyMd: '# v1', author: 'seed' });
      const client = await connect(fileBackedToken);

      const result = await client.callTool({ name: 'move_note', arguments: { note: note.id, folder: 'plans' } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/file-backed/);
    });
  });

  describe('list_notes', () => {
    it('a session cannot list_notes across a project boundary — only its own project\'s notes come back', async () => {
      const owner = await connect(scopedToken);
      await createNote(owner, { title: 'Owner note' });
      const stranger = await connect(otherToken);
      await createNote(stranger, { title: 'Stranger note' });

      const ownerList = text(await owner.callTool({ name: 'list_notes', arguments: {} }));
      const strangerList = text(await stranger.callTool({ name: 'list_notes', arguments: {} }));

      expect(ownerList.notes.map((n: { title: string }) => n.title)).toEqual(['Owner note']);
      expect(strangerList.notes.map((n: { title: string }) => n.title)).toEqual(['Stranger note']);
    });

    it('filters by folder', async () => {
      const client = await connect(scopedToken);
      await createNote(client, { title: 'In specs', folder: 'specs' });
      await createNote(client, { title: 'In plans', folder: 'plans' });

      const specsOnly = text(await client.callTool({ name: 'list_notes', arguments: { folder: 'specs' } }));

      expect(specsOnly.notes.map((n: { title: string }) => n.title)).toEqual(['In specs']);
    });
  });

  describe('search_notes', () => {
    it('finds a note by body content, project-scoped', async () => {
      const owner = await connect(scopedToken);
      await createNote(owner, { title: 'Daemon protocol', body_md: 'JSON-RPC over a local websocket' });
      const stranger = await connect(otherToken);
      await createNote(stranger, { title: 'Unrelated', body_md: 'websocket mentioned here too' });

      const results = text(await owner.callTool({ name: 'search_notes', arguments: { query: 'websocket' } }));

      expect(results.results).toHaveLength(1);
      expect(results.results[0].title).toBe('Daemon protocol');
      expect(results.results[0].snippet).toBeTruthy();
      expect(results.results[0].bodyMd).toBeUndefined();
    });

    it('treats a hyphen as literal input rather than an FTS operator', async () => {
      const client = await connect(scopedToken);
      await createNote(client, { title: 'x', body_md: 'session-service handles routing' });

      const result = await client.callTool({ name: 'search_notes', arguments: { query: 'session-service' } });

      expect(result.isError).toBeFalsy();
      expect(text(result).results).toHaveLength(1);
    });

    it('treats double quotes as literal input', async () => {
      const client = await connect(scopedToken);
      await createNote(client, { title: 'x', body_md: 'a "quoted" phrase appears here' });

      const result = await client.callTool({ name: 'search_notes', arguments: { query: '"quoted"' } });

      expect(result.isError).toBeFalsy();
    });

    it('treats AND, NEAR, *, and : as literal input, not FTS operators', async () => {
      const client = await connect(scopedToken);
      await createNote(client, { title: 'x', body_md: 'plain body' });

      for (const query of ['AND', 'NEAR', '*', ':', 'a:b']) {
        const result = await client.callTool({ name: 'search_notes', arguments: { query } });
        expect(result.isError).toBeFalsy();
      }
    });

    it('short-circuits an empty query to no results instead of an FTS syntax error', async () => {
      const client = await connect(scopedToken);
      await createNote(client, { title: 'x', body_md: 'plain body' });

      const result = await client.callTool({ name: 'search_notes', arguments: { query: '   ' } });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toEqual({ results: [], count: 0 });
    });

    it('caps results at 50', async () => {
      const client = await connect(scopedToken);
      for (let i = 0; i < 55; i++) await createNote(client, { title: `note ${i}`, body_md: 'needle appears' });

      const result = text(await client.callTool({ name: 'search_notes', arguments: { query: 'needle' } }));

      expect(result.results).toHaveLength(50);
      expect(result.count).toBe(50);
    });

    it('rejects a 10k-term query with a clear failure instead of building a giant FTS expression', async () => {
      const client = await connect(scopedToken);

      const result = await client.callTool({ name: 'search_notes', arguments: { query: Array.from({ length: 10_000 }, (_, i) => `t${i}`).join(' ') } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/too long/);
    });

    it('rejects more than 16 terms even when the query is short, and accepts exactly 16', async () => {
      const client = await connect(scopedToken);

      const seventeenTerms = await client.callTool({ name: 'search_notes', arguments: { query: 'a b c d e f g h i j k l m n o p q' } });
      const sixteenTerms = await client.callTool({ name: 'search_notes', arguments: { query: 'a b c d e f g h i j k l m n o p' } });

      expect(seventeenTerms.isError).toBe(true);
      expect(errorText(seventeenTerms)).toMatch(/too many terms/);
      expect(sixteenTerms.isError).toBeFalsy();
    });

    it('a query with a NUL byte searches its two halves as separate terms, like the REST search', async () => {
      const client = await connect(scopedToken);
      await createNote(client, { title: 'Pair', body_md: 'alpha beta' });

      const result = await client.callTool({ name: 'search_notes', arguments: { query: 'alp\u0000bet' } });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toMatchObject({ count: 1 });
    });

    it('a session cannot search_notes across a project boundary', async () => {
      const owner = await connect(scopedToken);
      await createNote(owner, { title: 'Owner note', body_md: 'unique-term-zzz' });
      const stranger = await connect(otherToken);

      const strangerResult = text(await stranger.callTool({ name: 'search_notes', arguments: { query: 'unique-term-zzz' } }));

      expect(strangerResult.results).toHaveLength(0);
    });
  });
});
