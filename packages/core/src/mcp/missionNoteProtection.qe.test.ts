import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const MISSION_FILE = 'mission.md';
const HIJACK = 'hijacked by an agent';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;

let daemon: Daemon;
let adminToken: string;
let worktreesRoot: string;
let clients: Client[];
const directories = createTempDirTracker();

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const tokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const isRefused = (result: unknown) => (result as { isError?: boolean }).isError === true;

const adminApi = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...options.headers },
});

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'mission-protection', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenOf(sessionId)}` } } }));
  return client;
}

async function aRootSession(): Promise<string> {
  // The project root works in the worktrees root, so every child directory made below it belongs to the project.
  const directory = worktreesRoot;
  const response = await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name: 'Root', harness: 'fake', emoji: '🤖', projectId: PROJECT_ID }) });
  return ((await response.json()) as { id: string }).id;
}

async function spawn(parent: Client, extra: Json = {}): Promise<string> {
  const directory = join(worktreesRoot, `child-${randomUUID()}`);
  mkdirSync(directory);
  const result = await parent.callTool({ name: 'create_session', arguments: { directory, name: 'Spawned', ...extra } });
  return (JSON.parse(textOf(result)) as { id: string }).id;
}

const spawnManager = (parent: Client) => spawn(parent, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 } });

async function aNote(title: string): Promise<string> {
  const response = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title, bodyMd: `# ${title}\n\n## Scope\n\noriginal scope` }) });
  const created = (await response.json()) as { id?: string; data?: { id: string } };
  return created.id ?? created.data!.id;
}

/** Edits the note through the admin REST API, so it holds a second revision to restore from. */
async function reviseThroughAdminApi(noteId: string, bodyMd: string, expectedRev: number): Promise<Response> {
  return adminApi(`/api/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ projectId: PROJECT_ID, expectedRev, bodyMd }) });
}

const linkAsMission = (managerId: string, noteId: string | null) =>
  adminApi(`/api/managers/${managerId}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId: noteId }) });

interface NoteState { exists: boolean; bodyMd: string | undefined; rev: number | undefined; folder: string | null | undefined; versions: number }
function stateOf(noteId: string): NoteState {
  const row = daemon.db.prepare('SELECT body_md, rev, folder FROM notes WHERE id = ?').get(noteId) as { body_md: string; rev: number; folder: string | null } | undefined;
  const { count } = daemon.db.prepare('SELECT COUNT(*) AS count FROM note_versions WHERE note_id = ?').get(noteId) as { count: number };
  return { exists: row !== undefined, bodyMd: row?.body_md, rev: row?.rev, folder: row?.folder, versions: count };
}

interface WriteTool { tool: string; argumentsFor: (noteId: string, rev: number) => Json }
const WRITE_TOOLS: WriteTool[] = [
  { tool: 'update_note', argumentsFor: (note, rev) => ({ note, body_md: HIJACK, expected_rev: rev }) },
  { tool: 'update_note_section', argumentsFor: (note, rev) => ({ note, heading: 'Scope', content: HIJACK, expected_rev: rev }) },
  { tool: 'append_to_note', argumentsFor: (note) => ({ note, content: HIJACK }) },
  { tool: 'move_note', argumentsFor: (note, rev) => ({ note, folder: 'plans', expected_rev: rev }) },
  { tool: 'restore_note_version', argumentsFor: (note, rev) => ({ note, rev: 1, expected_rev: rev }) },
  { tool: 'delete_note', argumentsFor: (note) => ({ note }) },
];

interface Scene { managerId: string; manager: Client; child: Client; bystander: Client; missionNoteId: string }

async function aSceneWithAMissionNote(): Promise<Scene> {
  const bystander = await connect(await aRootSession());
  const rootId = await aRootSession();
  const root = await connect(rootId);
  const managerId = await spawnManager(root);
  const manager = await connect(managerId);
  await manager.callTool({ name: 'get_manager_base', arguments: {} });
  const child = await connect(await spawn(manager));
  const missionNoteId = await aNote('Mission');
  await reviseThroughAdminApi(missionNoteId, '# Mission\n\n## Scope\n\nrevised scope', 1);
  await linkAsMission(managerId, missionNoteId);
  return { managerId, manager, child, bystander, missionNoteId };
}

beforeEach(async () => {
  clients = [];
  const home = directories.make('mission-protection-');
  const docsFolder = directories.make('mission-docs-');
  mkdirSync(join(docsFolder, 'specs'));
  writeFileSync(join(docsFolder, 'specs', MISSION_FILE), '# Mission on disk');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: docsFolder, createdAt: 't0' });
  seedDb.close();
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('a note linked as the mission of a manager', () => {
  const CALLERS: { who: string; pick: (scene: Scene) => Client }[] = [
    { who: 'the manager itself', pick: (scene) => scene.manager },
    { who: 'a child of that manager', pick: (scene) => scene.child },
    { who: 'an unrelated session of the same project', pick: (scene) => scene.bystander },
  ];

  describe.each(CALLERS)('written by $who', ({ pick }) => {
    it.each(WRITE_TOOLS)('refuses $tool and changes nothing', async ({ tool, argumentsFor }) => {
      const scene = await aSceneWithAMissionNote();
      const before = stateOf(scene.missionNoteId);

      const result = await pick(scene).callTool({ name: tool, arguments: argumentsFor(scene.missionNoteId, before.rev!) });

      expect(isRefused(result)).toBe(true);
      expect(textOf(result)).toContain('error unauthorized');
      expect(textOf(result)).toContain('Ask a human to edit the mission note');
      expect(stateOf(scene.missionNoteId)).toEqual(before);
    });

    it('still reads it', async () => {
      const scene = await aSceneWithAMissionNote();
      const reader = pick(scene);
      const { missionNoteId } = scene;

      const note = await reader.callTool({ name: 'get_note', arguments: { note: missionNoteId } });
      const versions = await reader.callTool({ name: 'list_note_versions', arguments: { note: missionNoteId } });
      const version = await reader.callTool({ name: 'get_note_version', arguments: { note: missionNoteId, rev: 1 } });

      expect([isRefused(note), isRefused(versions), isRefused(version)]).toEqual([false, false, false]);
      expect(textOf(note)).toContain('revised scope');
    });
  });

  it('is modified by the admin REST API', async () => {
    const scene = await aSceneWithAMissionNote();
    const { rev } = stateOf(scene.missionNoteId);

    const response = await reviseThroughAdminApi(scene.missionNoteId, 'written by the human', rev!);

    expect(response.status).toBe(200);
    expect(stateOf(scene.missionNoteId).bodyMd).toBe('written by the human');
  });

  it('is modifiable again by an agent once unlinked', async () => {
    const scene = await aSceneWithAMissionNote();
    await linkAsMission(scene.managerId, null);
    const { rev } = stateOf(scene.missionNoteId);

    const result = await scene.manager.callTool({ name: 'update_note', arguments: { note: scene.missionNoteId, body_md: 'free again', expected_rev: rev } });

    expect(isRefused(result)).toBe(false);
    expect(stateOf(scene.missionNoteId).bodyMd).toBe('free again');
  });

  it('stays protected while another manager still links it', async () => {
    const scene = await aSceneWithAMissionNote();
    const secondManagerId = await spawnManager(await connect(await aRootSession()));
    await linkAsMission(secondManagerId, scene.missionNoteId);
    await linkAsMission(scene.managerId, null);
    const before = stateOf(scene.missionNoteId);

    const result = await scene.bystander.callTool({ name: 'update_note', arguments: { note: scene.missionNoteId, body_md: HIJACK, expected_rev: before.rev } });

    expect(isRefused(result)).toBe(true);
    expect(stateOf(scene.missionNoteId)).toEqual(before);
  });

  it('is protected by its link whatever its id', async () => {
    const scene = await aSceneWithAMissionNote();
    const otherNoteId = await aNote('Another mission');
    const otherManagerId = await spawnManager(await connect(await aRootSession()));
    await linkAsMission(otherManagerId, otherNoteId);
    const before = stateOf(otherNoteId);

    const result = await scene.child.callTool({ name: 'update_note', arguments: { note: otherNoteId, body_md: HIJACK, expected_rev: before.rev } });

    expect(isRefused(result)).toBe(true);
    expect(stateOf(otherNoteId)).toEqual(before);
  });

  it('is refused when it is backed by a file', async () => {
    const scene = await aSceneWithAMissionNote();
    const { id: fileNoteId } = daemon.db.prepare('SELECT id FROM notes WHERE file_path IS NOT NULL').get() as { id: string };
    await linkAsMission(scene.managerId, fileNoteId);
    const before = stateOf(fileNoteId);

    const result = await scene.manager.callTool({ name: 'update_note', arguments: { note: fileNoteId, body_md: HIJACK, expected_rev: before.rev } });

    expect(isRefused(result)).toBe(true);
    expect(textOf(result)).toContain('error unauthorized');
    expect(stateOf(fileNoteId)).toEqual(before);
  });
});

describe('a note of the project that no manager links', () => {
  it.each(WRITE_TOOLS)('stays writable through $tool', async ({ tool, argumentsFor }) => {
    const scene = await aSceneWithAMissionNote();
    const freeNoteId = await aNote('Free note');
    await reviseThroughAdminApi(freeNoteId, '# Free note\n\n## Scope\n\nrevised', 1);
    const { rev } = stateOf(freeNoteId);

    const result = await scene.manager.callTool({ name: tool, arguments: argumentsFor(freeNoteId, rev!) });

    expect(isRefused(result)).toBe(false);
  });
});

describe('a manager', () => {
  it('still creates notes', async () => {
    const scene = await aSceneWithAMissionNote();

    const result = await scene.manager.callTool({ name: 'create_note', arguments: { title: 'Plan of the week', body_md: 'steps' } });

    expect(isRefused(result)).toBe(false);
  });

  it('still writes in its journal table', async () => {
    const scene = await aSceneWithAMissionNote();
    const store = JSON.parse(textOf(await scene.manager.callTool({ name: 'create_data_store', arguments: { display_name: 'Journal' } }))) as { id: string };
    await scene.manager.callTool({ name: 'set_argus_log_store', arguments: { store_id: store.id } });
    const column = JSON.parse(textOf(await scene.manager.callTool({ name: 'add_data_store_column', arguments: { store: store.id, display_name: 'Entry', column_type: 'text' } }))) as { id: string };

    const result = await scene.manager.callTool({ name: 'insert_data_store_rows', arguments: { store: store.id, rows: [{ [column.id]: 'pulse done' }] } });

    expect(isRefused(result)).toBe(false);
  });
});
