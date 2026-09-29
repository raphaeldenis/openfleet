import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chmodSync, mkdtempSync } from 'node:fs';
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
let fileBackedToken: string;
let fileBackedProjectId: string;

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
  const docsFolderPath = mkdtempSync(join(tmpdir(), 'of-docs-'));
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
  const fileBacked = await sessions.create({ directory: '/tmp', name: 'Frodo', harness: 'fake', emoji: '💍' });
  assignProject(fileBacked.id, fileBackedProjectId);
  scopedToken = harness.launches[0]!.mcpToken;
  otherToken = harness.launches[1]!.mcpToken;
  fileBackedToken = harness.launches[2]!.mcpToken;
});
afterEach(() => server.close());

async function createNote(client: Client, overrides: Partial<{ title: string; body_md: string; folder: string }> = {}) {
  return text(await client.callTool({ name: 'create_note', arguments: { title: 'Untitled', body_md: '## Log\nentry 1', ...overrides } }));
}

describe('note version tools', () => {
  it('lists the note version tools', async () => {
    const client = await connect(scopedToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['append_to_note', 'update_note_section', 'get_note_version', 'list_note_versions', 'restore_note_version']),
    );
  });

  describe('append_to_note', () => {
    it('appends without requiring a rev and always bumps it', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client);

      const updated = text(await client.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'entry 2' } }));

      expect(updated.bodyMd).toContain('entry 2');
      expect(updated.rev).toBe(note.rev + 1);
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'x' } });
      const missingResult = await stranger.callTool({ name: 'append_to_note', arguments: { note: 'does-not-exist', content: 'x' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('refuses a file-backed note clearly rather than racing a rev-free write against writeThrough\'s CAS', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: '## Log\nentry 1', author: 'seed' });
      const client = await connect(fileBackedToken);

      const result = await client.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'entry 2' } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/file-backed/);
    });
  });

  describe('update_note_section', () => {
    it('replaces a section\'s content, sending content without the heading line', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: '## Log\nold entry' });

      const updated = text(await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'new entry', expected_rev: note.rev } }));

      expect(updated.bodyMd).toBe('## Log\nnew entry');
    });

    it('on a stale rev returns a non-throwing error result with the current rev', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: '## Log\nv1' });
      await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'v2', expected_rev: note.rev } });

      const result = await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'v3-stale', expected_rev: note.rev } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toBe('409 stale_revision, current rev: 2');
    });

    it('a stale caller gets stale_revision even when the section no longer exists', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: '## Log\nv1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: '## Other\nv2', expected_rev: note.rev } });

      const result = await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'x', expected_rev: note.rev } });

      expect(errorText(result)).toBe('409 stale_revision, current rev: 2');
    });

    it('a fresh caller naming a missing section gets the section error', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: '## Log\nv1' });

      const result = await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Nope', content: 'x', expected_rev: note.rev } });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toBe('section "Nope" not found');
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner, { body_md: '## Log\nv1' });
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'x', expected_rev: note.rev } });
      const missingResult = await stranger.callTool({ name: 'update_note_section', arguments: { note: 'does-not-exist', heading: 'Log', content: 'x', expected_rev: 1 } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('writes through to disk for a file-backed note', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: '## Log\nold entry', author: 'seed' });
      const client = await connect(fileBackedToken);

      const updated = text(await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'new entry', expected_rev: note.rev } }));

      expect(updated.bodyMd).toBe('## Log\nnew entry');
      expect(nodeDocsFolderFs.readFileSync(note.filePath!)).toBe('## Log\nnew entry');
    });
  });

  describe('a file-backed note whose file cannot be read', () => {
    it.skipIf(process.getuid?.() === 0)('fails opaquely and leaves the file and the note untouched', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: '## Log\nold entry', author: 'seed' });
      const client = await connect(fileBackedToken);
      chmodSync(note.filePath!, 0o000);

      const result = await client.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'Log', content: 'new entry', expected_rev: note.rev } });

      chmodSync(note.filePath!, 0o600);
      expect(result.isError).toBe(true);
      expect(errorText(result)).toBe('request failed');
      expect(nodeDocsFolderFs.readFileSync(note.filePath!)).toBe('## Log\nold entry');
      expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: '## Log\nold entry', rev: 1 });
    });
  });

  describe('get_note_version', () => {
    it('returns the full body of a past revision', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: 'v1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });

      const version = text(await client.callTool({ name: 'get_note_version', arguments: { note: note.id, rev: 1 } }));

      expect(version.bodyMd).toBe('v1');
    });

    it('fails clearly for a rev that does not exist', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client);

      const result = await client.callTool({ name: 'get_note_version', arguments: { note: note.id, rev: 99 } });

      expect(result.isError).toBe(true);
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'get_note_version', arguments: { note: note.id, rev: 1 } });
      const missingResult = await stranger.callTool({ name: 'get_note_version', arguments: { note: 'does-not-exist', rev: 1 } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });
  });

  describe('get_note_version across projects', () => {
    it('returns the caller\'s own body, never another project\'s version of the same rev', async () => {
      const owner = await connect(scopedToken);
      const ownerNote = await createNote(owner, { body_md: 'owner secret' });
      const stranger = await connect(otherToken);
      const strangerNote = await createNote(stranger, { body_md: 'stranger body' });

      const ownVersion = text(await stranger.callTool({ name: 'get_note_version', arguments: { note: strangerNote.id, rev: 1 } }));
      const guessed = await stranger.callTool({ name: 'get_note_version', arguments: { note: ownerNote.id, rev: 1 } });

      expect(ownVersion.bodyMd).toBe('stranger body');
      expect(guessed.isError).toBe(true);
      expect(errorText(guessed)).not.toContain('owner secret');
    });
  });

  describe('list_note_versions', () => {
    it('lists one version per write, newest last, without bodies', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: 'v1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });

      const result = text(await client.callTool({ name: 'list_note_versions', arguments: { note: note.id } }));

      expect(result.versions).toHaveLength(2);
      expect(result.versions.map((v: { rev: number }) => v.rev)).toEqual([1, 2]);
      expect(result.versions[0].bodyMd).toBeUndefined();
    });

    it('attributes every version to "<emoji> <name>" after create, update, append and restore', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: 'v1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });
      await client.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'more' } });
      await client.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1 } });

      const result = text(await client.callTool({ name: 'list_note_versions', arguments: { note: note.id } }));

      expect(result.versions.map((v: { author: string }) => v.author)).toEqual(Array(4).fill('⛏️ Gimli'));
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'list_note_versions', arguments: { note: note.id } });
      const missingResult = await stranger.callTool({ name: 'list_note_versions', arguments: { note: 'does-not-exist' } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });
  });

  describe('restore_note_version', () => {
    it('creates a new revision rather than mutating the restored one', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: 'v1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });

      const restored = text(await client.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1 } }));

      expect(restored.bodyMd).toBe('v1');
      expect(restored.rev).toBe(3);
      const versions = text(await client.callTool({ name: 'list_note_versions', arguments: { note: note.id } }));
      expect(versions.versions.map((v: { rev: number }) => v.rev)).toEqual([1, 2, 3]);
      const originalVersion = text(await client.callTool({ name: 'get_note_version', arguments: { note: note.id, rev: 1 } }));
      expect(originalVersion.bodyMd).toBe('v1');
    });

    it('with expected_rev, refuses a stale caller and leaves the note untouched', async () => {
      const client = await connect(scopedToken);
      const note = await createNote(client, { body_md: 'v1' });
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });

      const stale = await client.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: 1 } });
      const fresh = text(await client.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: 2 } }));

      expect(errorText(stale)).toBe('409 stale_revision, current rev: 2');
      expect(fresh).toMatchObject({ bodyMd: 'v1', rev: 3 });
    });

    it('on another project\'s note fails exactly like a missing note', async () => {
      const owner = await connect(scopedToken);
      const note = await createNote(owner);
      const stranger = await connect(otherToken);

      const strangerResult = await stranger.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1 } });
      const missingResult = await stranger.callTool({ name: 'restore_note_version', arguments: { note: 'does-not-exist', rev: 1 } });

      expect(strangerResult.isError).toBe(true);
      expect(missingResult.isError).toBe(true);
      expect(errorText(strangerResult)).toBe(errorText(missingResult));
    });

    it('writes through to disk for a file-backed note', async () => {
      const note = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });
      const client = await connect(fileBackedToken);
      await client.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'v2', expected_rev: note.rev } });

      const restored = text(await client.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1 } }));

      expect(restored.bodyMd).toBe('v1');
      expect(nodeDocsFolderFs.readFileSync(note.filePath!)).toBe('v1');
    });
  });
});
