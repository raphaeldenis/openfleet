import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Note, NoteFolder } from '@openfleet/shared';
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
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from './mcpServer.js';
import { knowledgeSearchFor } from './knowledgeTools.testkit.js';

const MAX_NOTES_PER_FOLDER = 200;
const SECRET_DOCS_FOLDER = '/Users/someone/secret-docs';

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let noteRepo: NoteRepository;
let projectOneToken: string;
let projectTwoToken: string;
let noProjectToken: string;

const connect = async (token: string) => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const jsonOf = (result: unknown) => JSON.parse(textOf(result));

const insertNote = (note: { id: string; projectId: string; title: string; folder: NoteFolder | null; filePath?: string }) => {
  const fullNote: Note = {
    ...note, bodyMd: 'body', filePath: note.filePath ?? null, sourceHash: null, rev: 1, shared: false, createdAt: `t-${note.id}`, updatedAt: `t-${note.id}`,
  };
  noteRepo.insert(fullNote);
};

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
  projects.insert({ id: 'p1', name: 'OpenFleet', docsFolderPath: SECRET_DOCS_FOLDER, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Other Project', docsFolderPath: null, createdAt: 't1' });
  const storeRepo = new DataStoreRepository(db);
  let counter = 0;
  const clock = () => '2026-01-01T00:00:00.000Z';
  const stores = new DataStoreService({ repo: storeRepo, db, clock, newId: () => `id-${++counter}` });
  noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock, newId: () => `id-${++counter}` });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ knowledgeSearch: knowledgeSearchFor(db),
      sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, projects,
      workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }),
    }),
  });

  const projectOneSession = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', projectOneSession.id);
  const projectTwoSession = await sessions.create({ directory: '/tmp', name: 'Legolas', harness: 'fake', emoji: '🏹' });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p2', projectTwoSession.id);
  await sessions.create({ directory: '/tmp', name: 'Rootless', harness: 'fake', emoji: '👤' });
  projectOneToken = harness.launches[0]!.mcpToken;
  projectTwoToken = harness.launches[1]!.mcpToken;
  noProjectToken = harness.launches[2]!.mcpToken;
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe('list_projects', () => {
  it('lists every project with its id, name and whether it has a docs folder', async () => {
    const client = await connect(projectOneToken);

    const result = await client.callTool({ name: 'list_projects', arguments: {} });

    expect(jsonOf(result)).toEqual([
      { id: 'p1', name: 'OpenFleet', hasDocsFolder: true },
      { id: 'p2', name: 'Other Project', hasDocsFolder: false },
    ]);
  });

  it('never tells the absolute docs folder path', async () => {
    const client = await connect(projectOneToken);

    const result = await client.callTool({ name: 'list_projects', arguments: {} });

    expect(textOf(result)).not.toContain(SECRET_DOCS_FOLDER);
  });

  it('answers a session that has no project', async () => {
    const client = await connect(noProjectToken);

    const result = await client.callTool({ name: 'list_projects', arguments: {} });

    expect(jsonOf(result)).toHaveLength(2);
  });
});

describe('list_project_folders', () => {
  it('lists the four docs folders in order with the notes of each, found by project name in any case', async () => {
    insertNote({ id: 'n1', projectId: 'p1', title: 'Design', folder: 'specs' });
    insertNote({ id: 'n2', projectId: 'p1', title: 'Rollout', folder: 'plans' });
    insertNote({ id: 'n3', projectId: 'p1', title: 'Scratch', folder: null });
    const client = await connect(projectOneToken);

    const result = jsonOf(await client.callTool({ name: 'list_project_folders', arguments: { project: 'openFLEET' } }));

    expect(result.project).toEqual({ id: 'p1', name: 'OpenFleet' });
    expect(result.folders.map((folder: { name: string }) => folder.name)).toEqual(['specs', 'plans', 'handoffs', 'reports']);
    expect(result.folders[0].notes).toEqual([{ id: 'n1', title: 'Design', fileBacked: false }]);
    expect(result.folders[1].notes).toEqual([{ id: 'n2', title: 'Rollout', fileBacked: false }]);
    expect(result.folders[2]).toEqual({ name: 'handoffs', noteCount: 0, notes: [], truncated: false });
    expect(result.unfiledNotes).toEqual([{ id: 'n3', title: 'Scratch', fileBacked: false }]);
  });

  it('finds the project by id', async () => {
    const client = await connect(projectOneToken);

    const result = jsonOf(await client.callTool({ name: 'list_project_folders', arguments: { project: 'p1' } }));

    expect(result.project.id).toBe('p1');
  });

  it('refuses a project that is not the caller project exactly like one that does not exist', async () => {
    const client = await connect(projectOneToken);

    const foreign = await client.callTool({ name: 'list_project_folders', arguments: { project: 'Other Project' } });
    const missing = await client.callTool({ name: 'list_project_folders', arguments: { project: 'Nowhere' } });

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toMatch(/^error project_not_found: /);
    expect(textOf(foreign).replace('Other Project', 'Nowhere')).toBe(textOf(missing));
  });

  it('does not show the notes of another project', async () => {
    insertNote({ id: 'foreign', projectId: 'p2', title: 'Foreign secret', folder: 'specs' });
    const client = await connect(projectOneToken);

    const result = await client.callTool({ name: 'list_project_folders', arguments: { project: 'OpenFleet' } });

    expect(textOf(result)).not.toContain('Foreign secret');
  });

  it('refuses a session that has no project', async () => {
    const client = await connect(noProjectToken);

    const result = await client.callTool({ name: 'list_project_folders', arguments: { project: 'OpenFleet' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^error project_not_found: /);
  });

  it('bounds the notes of a folder and says when it cut them', async () => {
    for (let index = 0; index < MAX_NOTES_PER_FOLDER + 5; index++) insertNote({ id: `n${String(index).padStart(3, '0')}`, projectId: 'p1', title: `Spec ${index}`, folder: 'specs' });
    const client = await connect(projectOneToken);

    const result = jsonOf(await client.callTool({ name: 'list_project_folders', arguments: { project: 'OpenFleet' } }));

    const specs = result.folders[0];
    expect(specs.notes).toHaveLength(MAX_NOTES_PER_FOLDER);
    expect(specs.noteCount).toBe(MAX_NOTES_PER_FOLDER + 5);
    expect(specs.truncated).toBe(true);
  });

  it('never reveals a file path, even for a file-backed note whose file sits outside the docs folder', async () => {
    insertNote({ id: 'escaped', projectId: 'p1', title: 'Escaped', folder: 'reports', filePath: '/etc/passwd' });
    const client = await connect(projectOneToken);

    const result = await client.callTool({ name: 'list_project_folders', arguments: { project: 'OpenFleet' } });

    expect(textOf(result)).not.toContain('/etc/passwd');
    expect(textOf(result)).not.toContain(SECRET_DOCS_FOLDER);
    expect(jsonOf(result).folders[3].notes).toEqual([{ id: 'escaped', title: 'Escaped', fileBacked: true }]);
  });

  it('answers a session of the other project for its own project', async () => {
    const client = await connect(projectTwoToken);

    const result = jsonOf(await client.callTool({ name: 'list_project_folders', arguments: { project: 'other project' } }));

    expect(result.project.id).toBe('p2');
  });
});
