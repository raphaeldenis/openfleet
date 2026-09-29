import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
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
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { newId } from '../ids.js';
import { SessionService } from '../sessions/sessionService.js';
import { createMcpHandler } from './mcpServer.js';

const WORKTREES_ROOT = '/tmp/of-wt';

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let harness: FakeHarness;
let managerDirectory: string;
let managerId: string;
let managerToken: string;

beforeEach(async () => {
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  managerDirectory = mkdtempSync(join(WORKTREES_ROOT, 'manager-'));
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
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: WORKTREES_ROOT }) });
  const manager = await sessions.create({ directory: managerDirectory, name: 'Lead', harness: 'fake', emoji: '🧭' });
  managerId = manager.id;
  managerToken = harness.launches[0]!.mcpToken;
});
afterEach(() => server.close());

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type ToolResult = { isError?: boolean; content: { text: string }[] };
const callCreateSession = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: 'create_session', arguments: { name: 'Child', ...args } })) as ToolResult;
const errorText = (result: ToolResult) => result.content[0]!.text;

describe('spawn directory guard', () => {
  it('user can be refused when a manager spawns a child into its own directory, and no session is created', async () => {
    const manager = await connect(managerToken);
    const sessionCountBefore = sessions.list().length;

    const result = await callCreateSession(manager, { directory: managerDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerDirectory);
    expect(errorText(result)).toContain(managerId);
    expect(errorText(result)).toMatch(/worktree/i);
    expect(sessions.list()).toHaveLength(sessionCountBefore);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the requested directory is a symbolic link to the manager directory', async () => {
    const manager = await connect(managerToken);
    const linkToManager = join(mkdtempSync(join(WORKTREES_ROOT, 'links-')), 'alias');
    symlinkSync(managerDirectory, linkToManager);

    const result = await callCreateSession(manager, { directory: linkToManager });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the manager directory is reached through a symbolic link on the caller side', async () => {
    const linkToManager = join(mkdtempSync(join(WORKTREES_ROOT, 'links-')), 'alias');
    symlinkSync(managerDirectory, linkToManager);
    const viaLink = await sessions.create({ directory: linkToManager, name: 'ViaLink', harness: 'fake', emoji: '🔗' });
    const viaLinkClient = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(viaLinkClient, { directory: managerDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(viaLink.id);
  });

  it('user can be refused with allow_duplicate set, because no override lifts the refusal', async () => {
    const manager = await connect(managerToken);

    const result = await callCreateSession(manager, { directory: managerDirectory, allow_duplicate: true });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerDirectory);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can spawn a child in a subdirectory of the manager directory', async () => {
    const manager = await connect(managerToken);
    const subdirectory = join(managerDirectory, 'packages', 'feature');
    mkdirSync(subdirectory, { recursive: true });

    const result = await callCreateSession(manager, { directory: subdirectory });

    expect(result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(2);
  });

  it('user can spawn a child in a sibling directory whose name starts with the manager directory name', async () => {
    const manager = await connect(managerToken);
    const siblingWithSamePrefix = `${managerDirectory}-copy`;
    mkdirSync(siblingWithSamePrefix, { recursive: true });

    const result = await callCreateSession(manager, { directory: siblingWithSamePrefix });

    expect(result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when a child of a child spawns into the directory of the first manager', async () => {
    const manager = await connect(managerToken);
    const childDirectory = mkdtempSync(join(WORKTREES_ROOT, 'child-'));
    await callCreateSession(manager, { directory: childDirectory });
    const child = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(child, { directory: managerDirectory, name: 'Grandchild' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerDirectory);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when a child of a child spawns into its own parent directory, not only the manager one', async () => {
    const manager = await connect(managerToken);
    const childDirectory = mkdtempSync(join(WORKTREES_ROOT, 'child-'));
    await callCreateSession(manager, { directory: childDirectory });
    const child = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(child, { directory: childDirectory, name: 'Grandchild' });

    expect(result.isError).toBe(true);
    expect(harness.launches).toHaveLength(2);
  });
});
