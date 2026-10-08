import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { knowledgeSearchFor } from './knowledgeTools.testkit.js';

const WORKTREES_ROOT = '/tmp/of-wt';
mkdirSync(WORKTREES_ROOT, { recursive: true });
const volumeIsCaseInsensitive = existsSync(WORKTREES_ROOT.toUpperCase());

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let harness: FakeHarness;
let managerDirectory: string;
let managerId: string;
let managerToken: string;
let realManagerDirectory: string;
let createdDirectories: string[] = [];

const makeTrackedDirectory = (prefix: string) => {
  const directory = mkdtempSync(prefix);
  createdDirectories.push(directory);
  return directory;
};

const gitCheckHook: { beforeEachCheck?: () => void | Promise<void> } = {};
vi.mock('../git/worktrees.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../git/worktrees.js')>();
  return {
    ...original,
    sameGitRepository: async (...args: Parameters<typeof original.sameGitRepository>) => {
      await gitCheckHook.beforeEachCheck?.();
      return original.sameGitRepository(...args);
    },
  };
});

beforeEach(async () => {
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  gitCheckHook.beforeEachCheck = undefined;
  managerDirectory = makeTrackedDirectory(join(WORKTREES_ROOT, 'manager-'));
  realManagerDirectory = realpathSync.native(managerDirectory);
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
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ knowledgeSearch: knowledgeSearchFor(db), sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: WORKTREES_ROOT }) });
  const manager = await sessions.create({ directory: managerDirectory, name: 'Lead', harness: 'fake', emoji: '🧭' });
  managerId = manager.id;
  managerToken = harness.launches[0]!.mcpToken;
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

describe('spawn directory guard', () => {
  it('user can be refused when a manager spawns a child into its own directory, and no session is created', async () => {
    const manager = await connect(managerToken);
    const sessionCountBefore = sessions.list().length;

    const result = await callCreateSession(manager, { directory: managerDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(`directory ${realManagerDirectory} is already`);
    expect(errorText(result)).toContain(managerId);
    expect(errorText(result)).toMatch(/worktree/i);
    expect(sessions.list()).toHaveLength(sessionCountBefore);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the requested directory is a symbolic link to the manager directory', async () => {
    const manager = await connect(managerToken);
    const linkToManager = join(makeTrackedDirectory(join(WORKTREES_ROOT,'links-')), 'alias');
    symlinkSync(managerDirectory, linkToManager);

    const result = await callCreateSession(manager, { directory: linkToManager });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the manager directory is reached through a symbolic link on the caller side', async () => {
    const linkToManager = join(makeTrackedDirectory(join(WORKTREES_ROOT,'links-')), 'alias');
    symlinkSync(managerDirectory, linkToManager);
    const viaLink = await sessions.create({ directory: linkToManager, name: 'ViaLink', harness: 'fake', emoji: '🔗' });
    const viaLinkClient = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(viaLinkClient, { directory: managerDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(viaLink.id);
  });

  it('user can be refused with allow_duplicate set, because no override lifts the refusal', async () => {
    const manager = await connect(managerToken);
    const tools = await manager.listTools();
    const createSessionSchema = tools.tools.find((tool) => tool.name === 'create_session')!.inputSchema;
    expect(createSessionSchema.properties?.allow_duplicate).toMatchObject({ type: 'boolean' });

    const result = await callCreateSession(manager, { directory: managerDirectory, allow_duplicate: true });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(`directory ${realManagerDirectory} is already`);
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
    createdDirectories.push(siblingWithSamePrefix);

    const result = await callCreateSession(manager, { directory: siblingWithSamePrefix });

    expect(result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when a child of a child spawns into the directory of the first manager', async () => {
    const manager = await connect(managerToken);
    const childDirectory = makeTrackedDirectory(join(WORKTREES_ROOT,'child-'));
    await callCreateSession(manager, { directory: childDirectory });
    const child = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(child, { directory: managerDirectory, name: 'Grandchild' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(`directory ${realManagerDirectory} is already`);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when a child of a child spawns into its own parent directory, not only the manager one', async () => {
    const manager = await connect(managerToken);
    const childDirectory = makeTrackedDirectory(join(WORKTREES_ROOT,'child-'));
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
    const directory = makeTrackedDirectory(join(WORKTREES_ROOT,`${name}-`));
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
    const linksFolder = makeTrackedDirectory(join(WORKTREES_ROOT,'links-'));
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
    const loopFolder = makeTrackedDirectory(join(WORKTREES_ROOT,'loop-'));
    symlinkSync(join(loopFolder, 'b'), join(loopFolder, 'a'));
    symlinkSync(join(loopFolder, 'a'), join(loopFolder, 'b'));

    const result = await callCreateSession(manager, { directory: join(loopFolder, 'a') });

    expect(result.isError).toBe(true);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can spawn a child when the manager directory no longer exists on disk', async () => {
    const manager = await connect(managerToken);
    const childDirectory = makeTrackedDirectory(join(WORKTREES_ROOT,'child-'));
    rmSync(managerDirectory, { recursive: true, force: true });

    const result = await callCreateSession(manager, { directory: childDirectory });

    expect(result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(2);
  });

  it('user can read the directory refusal rather than the worktree-root refusal when a manager outside the worktrees root spawns into its own directory', async () => {
    const outsideDirectory = makeTrackedDirectory(join(tmpdir(),'of-outside-'));
    const outsider = await sessions.create({ directory: outsideDirectory, name: 'Outsider', harness: 'fake', emoji: '🚪' });
    const outsiderClient = await connect(harness.launches[1]!.mcpToken);

    const result = await callCreateSession(outsiderClient, { directory: outsideDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(outsider.id);
    expect(harness.launches).toHaveLength(2);
  });

  it.skipIf(!volumeIsCaseInsensitive)('user can be refused when the requested directory differs from the manager directory only by letter case on a case-insensitive volume', async () => {
    const manager = await connect(managerToken);
    const upperCased = managerDirectory.toUpperCase();

    const result = await callCreateSession(manager, { directory: upperCased });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(harness.launches).toHaveLength(1);
  });
});

const firmlinkSpellingIsAvailable = existsSync('/System/Volumes/Data/private/tmp');

describe('spawn directory guard, check-to-launch consistency', () => {
  it('user can be refused when the requested directory is swapped for a link to the manager directory after the checks started', async () => {
    const manager = await connect(managerToken);
    const requestedDirectory = makeTrackedDirectory(join(WORKTREES_ROOT, 'swapped-'));
    gitCheckHook.beforeEachCheck = () => {
      rmSync(requestedDirectory, { recursive: true, force: true });
      symlinkSync(managerDirectory, requestedDirectory);
    };

    const result = await callCreateSession(manager, { directory: requestedDirectory });

    expect(result.isError).toBe(true);
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused with a readable error when the caller is closed while the spawn is being checked', async () => {
    const manager = await connect(managerToken);
    gitCheckHook.beforeEachCheck = () => sessions.close(managerId);

    const result = await callCreateSession(manager, { directory: makeTrackedDirectory(join(WORKTREES_ROOT, 'orphan-')), name: 'Orphan' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain('is no longer live');
    expect(harness.launches).toHaveLength(1);
  });

  it.skipIf(!firmlinkSpellingIsAvailable)('user can be refused when the requested directory spells the manager directory through the macOS data volume', async () => {
    const manager = await connect(managerToken);

    const result = await callCreateSession(manager, { directory: `/System/Volumes/Data${realManagerDirectory}` });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(managerId);
    expect(errorText(result)).toContain('is already the working directory');
    expect(harness.launches).toHaveLength(1);
  });

  it('user can be refused when the directory a session started in is reached after its path was re-pointed elsewhere', async () => {
    const startedIn = makeTrackedDirectory(join(WORKTREES_ROOT, 'started-in-'));
    const repointedTo = makeTrackedDirectory(join(WORKTREES_ROOT, 'repointed-to-'));
    const link = join(makeTrackedDirectory(join(WORKTREES_ROOT, 'links-')), 'alias');
    symlinkSync(startedIn, link);
    const viaLink = await sessions.create({ directory: link, name: 'ViaLink', harness: 'fake', emoji: '🔗' });
    const viaLinkClient = await connect(harness.launches[1]!.mcpToken);
    unlinkSync(link);
    symlinkSync(repointedTo, link);

    const result = await callCreateSession(viaLinkClient, { directory: startedIn });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(viaLink.id);
    expect(harness.launches).toHaveLength(2);
  });
});

describe('spawn directory guard, sessions without a recorded directory', () => {
  it('user can be refused when a session started before its directory existed asks for that directory once it exists', async () => {
    const lateDirectory = join(WORKTREES_ROOT, `late-${Date.now()}-${process.pid}`);
    createdDirectories.push(lateDirectory);
    const lateSession = await sessions.create({ directory: lateDirectory, name: 'Late', harness: 'fake', emoji: '⏳' });
    const lateClient = await connect(harness.launches[1]!.mcpToken);
    mkdirSync(lateDirectory);

    const result = await callCreateSession(lateClient, { directory: lateDirectory });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(lateSession.id);
    expect(harness.launches).toHaveLength(2);
  });
});

describe('duplicate spawn guard', () => {
  const spawnChild = async (client: Client, args: Record<string, unknown>) => {
    const result = await callCreateSession(client, args);
    return { result, child: result.isError ? undefined : (JSON.parse(errorText(result)) as { id: string; name: string }) };
  };
  const newWorktree = (prefix: string) => makeTrackedDirectory(join(WORKTREES_ROOT, `${prefix}-`));

  it('user can be refused when a manager spawns a child with the name of one of its live children, and the answer names that child and its state', async () => {
    const manager = await connect(managerToken);
    const { child } = await spawnChild(manager, { directory: newWorktree('first'), name: 'Builder' });

    const { result } = await spawnChild(manager, { directory: newWorktree('second'), name: 'Builder' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(child!.id);
    expect(errorText(result)).toContain('Builder');
    expect(errorText(result)).toContain(`state ${sessions.get(child!.id)!.state}`);
    expect(errorText(result)).toContain('send_session_message');
    expect(errorText(result)).toContain(`close_session ${child!.id}`);
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when a manager spawns a child into the directory of one of its live children', async () => {
    const manager = await connect(managerToken);
    const sharedDirectory = newWorktree('shared');
    const { child } = await spawnChild(manager, { directory: sharedDirectory, name: 'Builder' });

    const { result } = await spawnChild(manager, { directory: sharedDirectory, name: 'Reviewer' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(child!.id);
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused when the requested directory is a symbolic link to the directory of a live child', async () => {
    const manager = await connect(managerToken);
    const sharedDirectory = newWorktree('shared');
    const { child } = await spawnChild(manager, { directory: sharedDirectory, name: 'Builder' });
    const link = join(newWorktree('links'), 'alias');
    symlinkSync(sharedDirectory, link);

    const { result } = await spawnChild(manager, { directory: link, name: 'Reviewer' });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(child!.id);
  });

  it('user can spawn a second child with the same name or the same directory when allow_duplicate is set', async () => {
    const manager = await connect(managerToken);
    const sharedDirectory = newWorktree('shared');
    await spawnChild(manager, { directory: sharedDirectory, name: 'Builder' });

    const sameName = await spawnChild(manager, { directory: newWorktree('other'), name: 'Builder', allow_duplicate: true });
    const sameDirectory = await spawnChild(manager, { directory: sharedDirectory, name: 'Reviewer', allow_duplicate: true });

    expect(sameName.result.isError).toBeFalsy();
    expect(sameDirectory.result.isError).toBeFalsy();
    expect(harness.launches).toHaveLength(4);
  });

  it('user can spawn again once the live child with that name and directory is closed', async () => {
    const manager = await connect(managerToken);
    const sharedDirectory = newWorktree('shared');
    const { child } = await spawnChild(manager, { directory: sharedDirectory, name: 'Builder' });
    await manager.callTool({ name: 'close_session', arguments: { session_id: child!.id } });

    const { result } = await spawnChild(manager, { directory: sharedDirectory, name: 'Builder' });

    expect(result.isError).toBeFalsy();
  });

  it('user can spawn a child whose name differs only by letter case from a live child', async () => {
    const manager = await connect(managerToken);
    await spawnChild(manager, { directory: newWorktree('first'), name: 'Builder' });

    const { result } = await spawnChild(manager, { directory: newWorktree('second'), name: 'builder' });

    expect(result.isError).toBeFalsy();
  });

  it('user can spawn a child with the name of a live child that belongs to another manager', async () => {
    const otherRoot = await sessions.create({ directory: newWorktree('other-root'), name: 'OtherLead', harness: 'fake', emoji: '🧭' });
    const manager = await connect(managerToken);
    const otherClient = await connect(harness.launches[1]!.mcpToken);
    const sharedDirectory = newWorktree('shared');
    await spawnChild(otherClient, { directory: sharedDirectory, name: 'Builder' });

    const { result } = await spawnChild(manager, { directory: sharedDirectory, name: 'Builder' });

    const liveBuilders = sessions.list().filter((s) => s.name === 'Builder' && s.state !== 'closed');
    expect(liveBuilders).toHaveLength(2);
    expect(liveBuilders.some((s) => s.parentId === otherRoot.id)).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it('user can spawn a child with the name of a live grandchild', async () => {
    const manager = await connect(managerToken);
    await spawnChild(manager, { directory: newWorktree('child'), name: 'Middle' });
    const middle = await connect(harness.launches[1]!.mcpToken);
    await spawnChild(middle, { directory: newWorktree('grand'), name: 'Builder' });

    const { result } = await spawnChild(manager, { directory: newWorktree('builder'), name: 'Builder' });

    expect(sessions.list().filter((s) => s.name === 'Builder' && s.state !== 'closed')).toHaveLength(2);
    expect(result.isError).toBeFalsy();
  });

  it('user can read the directory refusal rather than the duplicate one when the requested directory is the manager directory and the name is a live child name', async () => {
    const manager = await connect(managerToken);
    await spawnChild(manager, { directory: newWorktree('first'), name: 'Builder' });

    const { result } = await spawnChild(manager, { directory: managerDirectory, name: 'Builder', allow_duplicate: true });

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(`directory ${realManagerDirectory} is already the working directory`);
    expect(harness.launches).toHaveLength(2);
  });
});
