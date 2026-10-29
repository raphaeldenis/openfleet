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
import { governanceQueueFor } from '../governance/governanceQueueFor.testkit.js';
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
import { WorkingStateService } from '../workingState/workingStateService.js';
import { knowledgeSearchFor } from './knowledgeTools.testkit.js';
import { createMcpHandler } from './mcpServer.js';

const WORKTREES_ROOT = '/tmp/of-wt';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_NAME = 'Synthetic Fleet';
const SPAWN_REFUSAL_BUDGET_MS = 1000;

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let harness: FakeHarness;
let projectDirectory: string;
let projectManagerToken: string;
let createdDirectories: string[] = [];

const makeTrackedDirectory = (prefix: string) => {
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  const directory = mkdtempSync(prefix);
  createdDirectories.push(directory);
  return directory;
};

beforeEach(async () => {
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  projectDirectory = makeTrackedDirectory(join(WORKTREES_ROOT, 'project-'));
  db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: WORKTREES_ROOT, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const projects = new ProjectRepository(db);
  projects.insert({ id: PROJECT_ID, name: PROJECT_NAME, docsFolderPath: null, createdAt: 't0' });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ knowledgeSearch: knowledgeSearchFor(db), governanceQueue: governanceQueueFor(db), sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: WORKTREES_ROOT }) });
});

afterEach(async () => {
  await server.close();
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
  createdDirectories = [];
});

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };
const callCreateSession = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: 'create_session', arguments: { name: 'Child', ...args } })) as ToolResult;
const errorText = (result: ToolResult) => result.content[0]!.text;

const startProjectManager = async () => {
  await sessions.create({ directory: projectDirectory, name: 'Lead', harness: 'fake', emoji: '🧭', projectId: PROJECT_ID });
  projectManagerToken = harness.launches[0]!.mcpToken;
  return connect(projectManagerToken);
};

describe('create_session toward a directory outside every project', () => {
  it('refuses at once with directory_not_in_project, names the project to use, and creates no session', async () => {
    const manager = await startProjectManager();
    const outsideDirectory = makeTrackedDirectory(join(WORKTREES_ROOT, 'stray-'));
    const sessionCountBefore = sessions.list().length;
    const startedAt = Date.now();

    const result = await callCreateSession(manager, { directory: outsideDirectory });

    expect(Date.now() - startedAt).toBeLessThan(SPAWN_REFUSAL_BUDGET_MS);
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('directory_not_in_project');
    expect(errorText(result)).toContain(PROJECT_NAME);
    expect(sessions.list()).toHaveLength(sessionCountBefore);
    expect(harness.launches).toHaveLength(1);
  });

  it('spawns into a subdirectory of the project', async () => {
    const manager = await startProjectManager();
    const subdirectory = join(projectDirectory, 'packages', 'feature');
    mkdirSync(subdirectory, { recursive: true });

    const result = await callCreateSession(manager, { directory: subdirectory });

    expect(result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(2);
  });

  it('does not judge a caller that belongs to no project', async () => {
    await sessions.create({ directory: projectDirectory, name: 'Root', harness: 'fake', emoji: '🧭' });
    const rootCaller = await connect(harness.launches[0]!.mcpToken);
    const strayDirectory = makeTrackedDirectory(join(WORKTREES_ROOT, 'stray-'));

    const result = await callCreateSession(rootCaller, { directory: strayDirectory });

    expect(result.isError).toBeFalsy();
  });
});
