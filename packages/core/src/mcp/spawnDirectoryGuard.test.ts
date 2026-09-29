import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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

describe('spawn directory guard, hostile requests (QE)', () => {
  async function spawnDescendant(callerToken: string, name: string): Promise<{ client: Client; token: string }> {
    const caller = await connect(callerToken);
    const directory = mkdtempSync(join(WORKTREES_ROOT, `${name}-`));
    const launchesBefore = harness.launches.length;
    await callCreateSession(caller, { directory, name });
    const token = harness.launches[launchesBefore]!.mcpToken;
    return { client: await connect(token), token };
  }

  it('user can be refused when a great-grandchild spawns into the directory of the first manager, four levels down', async () => {
    const child = await spawnDescendant(managerToken, 'child');
    const grandchild = await spawnDescendant(child.token, 'grandchild');
    const greatGrandchild = await spawnDescendant(grandchild.token, 'great-grandchild');
    const launchesBefore = harness.launches.length;

    const result = await callCreateSession(greatGrandchild.client, { directory: managerDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(launchesBefore);
  });

  it('user can be refused when the requested directory carries a trailing slash', async () => {
    const manager = await connect(managerToken);

    const result = await callCreateSession(manager, { directory: `${managerDirectory}/` });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the requested directory reaches the manager directory through a dot-dot segment', async () => {
    const manager = await connect(managerToken);
    const subdirectory = join(managerDirectory, 'nested');
    mkdirSync(subdirectory);

    const result = await callCreateSession(manager, { directory: join(subdirectory, '..') });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the requested directory is a relative path that resolves to the manager directory', async () => {
    const manager = await connect(managerToken);

    const result = await callCreateSession(manager, { directory: relative(process.cwd(), managerDirectory) });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the requested directory is a chain of two symbolic links to the manager directory', async () => {
    const manager = await connect(managerToken);
    const linksFolder = mkdtempSync(join(WORKTREES_ROOT, 'links-'));
    symlinkSync(managerDirectory, join(linksFolder, 'first'));
    symlinkSync(join(linksFolder, 'first'), join(linksFolder, 'second'));

    const result = await callCreateSession(manager, { directory: join(linksFolder, 'second') });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused with a clean error and no session when the requested directory does not exist', async () => {
    const manager = await connect(managerToken);
    const sessionCountBefore = sessions.list().length;

    const result = await callCreateSession(manager, { directory: join(managerDirectory, 'missing') });

    expect(result.isError).toBe(true);
    expect(sessions.list()).toHaveLength(sessionCountBefore);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused with a clean error and no session when the requested directory is a symbolic link loop', async () => {
    const manager = await connect(managerToken);
    const loopFolder = mkdtempSync(join(WORKTREES_ROOT, 'loop-'));
    symlinkSync(join(loopFolder, 'b'), join(loopFolder, 'a'));
    symlinkSync(join(loopFolder, 'a'), join(loopFolder, 'b'));

    const result = await callCreateSession(manager, { directory: join(loopFolder, 'a') });

    expect(result.isError).toBe(true);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can spawn a child when the manager directory no longer exists on disk', async () => {
    const manager = await connect(managerToken);
    const childDirectory = mkdtempSync(join(WORKTREES_ROOT, 'child-'));
    rmSync(managerDirectory, { recursive: true, force: true });

    const result = await callCreateSession(manager, { directory: childDirectory });

    expect(result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(2);
  });

  it('user can read the directory refusal rather than the worktree-root refusal when a manager outside the worktrees root spawns into its own directory', async () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'of-outside-'));
    const outsider = await sessions.create({ directory: outsideDirectory, name: 'Outsider', harness: 'fake', emoji: '🚪' });
    const outsiderClient = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(outsiderClient, { directory: outsideDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(outsider.id);
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when the requested directory differs from the manager directory only by letter case on a case-insensitive volume', async () => {
    const manager = await connect(managerToken);
    const upperCased = managerDirectory.toUpperCase();
    const volumeIsCaseInsensitive = upperCased !== managerDirectory && existsSync(upperCased);
    if (!volumeIsCaseInsensitive) return;

    const result = await callCreateSession(manager, { directory: upperCased });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });
});
