import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
const PROJECT_ID = 'p1';
const SECRET_TITLE = 'TITLE-SECRET-4f1c';
const SECRET_BODY = 'BODY-SECRET-9a7e';
const FENCE_TITLE = 'fence';
const SETTLE_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 40_000;

interface NoteFrame { type: string; noteId?: string; projectId?: string; rev?: number; source?: string }

let daemon: Daemon;
let config: Config;
let sockets: WebSocket[] = [];
let rawFrames: string[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  rawFrames = [];
  await daemon.close();
  tempDirs.removeAll();
});

const adminApi = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const parsed = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

async function bootDaemon(docsFolderPath: string | null = null): Promise<void> {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-note-events-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'One', docsFolderPath, createdAt: 't0' });
  seedDb.close();
  daemon = await startDaemon(config);
}

async function agentInProject(): Promise<Client> {
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Agent', harness: 'fake', emoji: '🤖' }) })).json()) as { id: string };
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(PROJECT_ID, created.id);
  const client = new Client({ name: 'note-events', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(created.id)}` } } }));
  return client;
}

async function listenToEvents(): Promise<void> {
  const { ticket } = (await (await adminApi('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  sockets.push(socket);
  socket.addEventListener('message', (message) => rawFrames.push(String(message.data)));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await vi.waitFor(() => expect(rawFrames.some((frame) => frame.includes('"type":"snapshot"'))).toBe(true), { timeout: SETTLE_TIMEOUT_MS });
  rawFrames = [];
}

const noteFrames = (): NoteFrame[] => rawFrames.map((frame) => JSON.parse(frame) as NoteFrame).filter((frame) => frame.type.startsWith('note.'));

const createNoteOverRest = async (title = 'Mission', bodyMd = '## A\none\n\n## B\ntwo') =>
  (await (await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title, bodyMd }) })).json()) as { id: string; rev: number };
const patchNote = (noteId: string, payload: object) => adminApi(`/api/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ projectId: PROJECT_ID, ...payload }) });
const restoreNote = (noteId: string, payload: object) => adminApi(`/api/notes/${noteId}/restore`, { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, ...payload }) });

/**
 * Frames reach a socket in the order the daemon sent them: once the fence note's own event has arrived,
 * every event an earlier operation was going to send has arrived too, so what is on the list is complete.
 */
async function settledNoteFrames(): Promise<NoteFrame[]> {
  const fence = await createNoteOverRest(FENCE_TITLE, '');
  await vi.waitFor(() => expect(noteFrames().some((frame) => frame.noteId === fence.id)).toBe(true), { timeout: SETTLE_TIMEOUT_MS });
  return noteFrames().filter((frame) => frame.noteId !== fence.id);
}

describe('note events: one per successful write, sent after the commit, never with a title or a body', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sends note.created with the note id, the project id and rev 1 when a note is created over REST', async () => {
    await bootDaemon();
    await listenToEvents();

    const note = await createNoteOverRest();

    expect(await settledNoteFrames()).toEqual([{ type: 'note.created', noteId: note.id, projectId: PROJECT_ID, rev: 1 }]);
  });

  it('sends note.created when an agent creates a note', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    await listenToEvents();

    const created = parsed(await agent.callTool({ name: 'create_note', arguments: { title: 'From agent', body_md: 'x' } }));

    expect(await settledNoteFrames()).toEqual([{ type: 'note.created', noteId: created.id, projectId: PROJECT_ID, rev: 1 }]);
  });

  it('sends note.updated with source mcp for update_note, update_note_section, append_to_note and move_note, once each, with the rev the write returned', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    const note = await createNoteOverRest();
    await listenToEvents();

    const afterUpdate = parsed(await agent.callTool({ name: 'update_note', arguments: { note: note.id, body_md: '## A\nuno\n\n## B\ntwo', expected_rev: note.rev } }));
    const afterSection = parsed(await agent.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: 'B', content: 'deux', expected_rev: afterUpdate.rev } }));
    const afterAppend = parsed(await agent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'tail' } }));
    const afterMove = parsed(await agent.callTool({ name: 'move_note', arguments: { note: note.id, folder: 'specs' } }));

    expect(await settledNoteFrames()).toEqual([afterUpdate, afterSection, afterAppend, afterMove].map(({ rev }) => ({ type: 'note.updated', noteId: note.id, projectId: PROJECT_ID, rev, source: 'mcp' })));
  });

  it('sends one note.updated per PATCH with source rest, whether it changes the body, the title or both', async () => {
    await bootDaemon();
    await listenToEvents();
    const note = await createNoteOverRest();
    const bodyOnly = (await (await patchNote(note.id, { bodyMd: 'b2', expectedRev: note.rev })).json()) as { rev: number };
    const titleOnly = (await (await patchNote(note.id, { title: 'T2', expectedRev: bodyOnly.rev })).json()) as { rev: number };
    const both = (await (await patchNote(note.id, { title: 'T3', bodyMd: 'b3', expectedRev: titleOnly.rev })).json()) as { rev: number };

    const frames = await settledNoteFrames();

    expect(frames).toEqual([
      { type: 'note.created', noteId: note.id, projectId: PROJECT_ID, rev: 1 },
      ...[bodyOnly, titleOnly, both].map(({ rev }) => ({ type: 'note.updated', noteId: note.id, projectId: PROJECT_ID, rev, source: 'rest' })),
    ]);
  });

  it('sends note.updated with source restore for a restore over REST and over MCP', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    const note = await createNoteOverRest();
    await listenToEvents();

    const afterRestOverRest = (await (await restoreNote(note.id, { rev: 1, expectedRev: note.rev })).json()) as { rev: number };
    const afterRestoreOverMcp = parsed(await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: afterRestOverRest.rev } }));

    expect(await settledNoteFrames()).toEqual([afterRestOverRest, afterRestoreOverMcp].map(({ rev }) => ({ type: 'note.updated', noteId: note.id, projectId: PROJECT_ID, rev, source: 'restore' })));
  });

  it('sends note.deleted with the note id and the project id when an agent deletes a note, and no note.updated', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    const note = await createNoteOverRest();
    await listenToEvents();

    await agent.callTool({ name: 'delete_note', arguments: { note: note.id } });

    expect(await settledNoteFrames()).toEqual([{ type: 'note.deleted', noteId: note.id, projectId: PROJECT_ID }]);
  });

  it('sends no event for a write refused as stale_revision, over REST or MCP', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    const note = await createNoteOverRest();
    await agent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'moves the rev on' } });
    await listenToEvents();

    const restRefusal = await patchNote(note.id, { bodyMd: 'stale', expectedRev: note.rev });
    const mcpRefusal = await agent.callTool({ name: 'update_note', arguments: { note: note.id, body_md: 'stale', expected_rev: note.rev } });
    const restoreRefusal = await restoreNote(note.id, { rev: 1, expectedRev: note.rev });

    expect(restRefusal.status).toBe(409);
    expect(mcpRefusal.isError).toBe(true);
    expect(restoreRefusal.status).toBe(409);
    expect(await settledNoteFrames()).toEqual([]);
  });

  it('sends no event for a write that fails: oversized body, unknown note, invalid body', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    const note = await createNoteOverRest();
    await listenToEvents();

    const oversized = await patchNote(note.id, { bodyMd: 'x'.repeat(1024 * 1024 + 1), expectedRev: note.rev });
    const unknownNote = await patchNote('no-such-note', { bodyMd: 'x', expectedRev: 1 });
    const invalid = await patchNote(note.id, { bodyMd: 'x' });
    const agentUnknown = await agent.callTool({ name: 'append_to_note', arguments: { note: 'no-such-note', content: 'x' } });

    expect([oversized.status, unknownNote.status, invalid.status]).toEqual([413, 404, 400]);
    expect(agentUnknown.isError).toBe(true);
    expect(await settledNoteFrames()).toEqual([]);
  });

  it('carries neither the title nor the body in any frame, and nothing but the documented fields', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    await listenToEvents();

    const note = await createNoteOverRest(SECRET_TITLE, SECRET_BODY);
    await agent.callTool({ name: 'update_note', arguments: { note: note.id, body_md: `${SECRET_BODY} again`, expected_rev: note.rev } });
    await patchNote(note.id, { title: `${SECRET_TITLE} renamed`, expectedRev: note.rev + 1 });
    await agent.callTool({ name: 'delete_note', arguments: { note: note.id } });
    const frames = await settledNoteFrames();

    expect(frames.map(({ type }) => type)).toEqual(['note.created', 'note.updated', 'note.updated', 'note.deleted']);
    expect(rawFrames.join('\n')).not.toContain('TITLE-SECRET');
    expect(rawFrames.join('\n')).not.toContain('BODY-SECRET');
    expect(frames.map((frame) => Object.keys(frame).sort())).toEqual([
      ['noteId', 'projectId', 'rev', 'type'],
      ['noteId', 'projectId', 'rev', 'source', 'type'],
      ['noteId', 'projectId', 'rev', 'source', 'type'],
      ['noteId', 'projectId', 'type'],
    ]);
  });

  it('keeps the event order of ten consecutive appends: ten events, ascending revs, no duplicate for the retry loop', async () => {
    await bootDaemon();
    const agent = await agentInProject();
    const note = await createNoteOverRest();
    await listenToEvents();

    for (let index = 0; index < 10; index++) await agent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: `line ${index}` } });
    const frames = await settledNoteFrames();

    expect(frames.map(({ rev }) => rev)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('sends the event when the write is already committed: a reader asked right after the frame sees the announced rev', async () => {
    await bootDaemon();
    await listenToEvents();
    const note = await createNoteOverRest();
    await vi.waitFor(() => expect(noteFrames()).toHaveLength(1), { timeout: SETTLE_TIMEOUT_MS });
    const revRead: number[] = [];
    sockets[0]!.addEventListener('message', async (message) => {
      const frame = JSON.parse(String(message.data)) as NoteFrame;
      if (frame.type !== 'note.updated') return;
      const view = (await (await adminApi(`/api/notes/${frame.noteId}?projectId=${PROJECT_ID}`)).json()) as { rev: number };
      revRead.push(view.rev);
    });

    const written = (await (await patchNote(note.id, { bodyMd: 'after', expectedRev: note.rev })).json()) as { rev: number };

    await vi.waitFor(() => expect(revRead).toEqual([written.rev]), { timeout: SETTLE_TIMEOUT_MS });
  });
});

describe('note events for a note backed by a file', { timeout: TEST_TIMEOUT_MS }, () => {
  const NOTE_FILE_NAME = '2026-10-01-design.md';
  const docsFolderWithANote = (): string => {
    const folder = tempDirs.make('of-note-events-docs-');
    mkdirSync(join(folder, 'specs'));
    writeFileSync(join(folder, 'specs', NOTE_FILE_NAME), '## A\none');
    return folder;
  };
  const fileBackedNoteId = () => (daemon.db.prepare('SELECT id FROM notes WHERE title = ?').get('design') as { id: string }).id;

  it('sends one note.updated with source mcp for an MCP write through the file, and one with source rest for a PATCH', async () => {
    await bootDaemon(docsFolderWithANote());
    const agent = await agentInProject();
    const noteId = fileBackedNoteId();
    const rev = (daemon.db.prepare('SELECT rev FROM notes WHERE id = ?').get(noteId) as { rev: number }).rev;
    await listenToEvents();

    const afterMcp = parsed(await agent.callTool({ name: 'update_note', arguments: { note: noteId, body_md: '## A\nmcp', expected_rev: rev } }));
    const afterRest = (await (await patchNote(noteId, { bodyMd: '## A\nrest', expectedRev: afterMcp.rev })).json()) as { rev: number };

    expect(await settledNoteFrames()).toEqual([
      { type: 'note.updated', noteId, projectId: PROJECT_ID, rev: afterMcp.rev, source: 'mcp' },
      { type: 'note.updated', noteId, projectId: PROJECT_ID, rev: afterRest.rev, source: 'rest' },
    ]);
  });

  it('sends note.updated with source file when the file is edited on disk, once', async () => {
    const folder = docsFolderWithANote();
    await bootDaemon(folder);
    const noteId = fileBackedNoteId();
    await listenToEvents();

    await vi.waitFor(() => {
      writeFileSync(join(folder, 'specs', NOTE_FILE_NAME), '## A\nedited on disk');
      expect(noteFrames().some((frame) => frame.type === 'note.updated')).toBe(true);
    }, { timeout: SETTLE_TIMEOUT_MS, interval: 250 });
    const frames = await settledNoteFrames();

    expect(frames).toEqual([{ type: 'note.updated', noteId, projectId: PROJECT_ID, rev: 2, source: 'file' }]);
  });

  it('sends no event when the note file vanished and the write fails', async () => {
    const folder = docsFolderWithANote();
    await bootDaemon(folder);
    const agent = await agentInProject();
    const noteId = fileBackedNoteId();
    await listenToEvents();
    rmSync(join(folder, 'specs'), { recursive: true });

    const refused = await agent.callTool({ name: 'update_note', arguments: { note: noteId, body_md: 'x', expected_rev: 1 } });

    expect(refused.isError).toBe(true);
    expect((await settledNoteFrames()).filter((frame) => frame.type === 'note.updated' && frame.source === 'mcp')).toEqual([]);
  });
});
