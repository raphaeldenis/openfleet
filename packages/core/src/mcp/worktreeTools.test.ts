import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MANAGER_ROLE, type RemovedWorktree, type WorktreeList } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { createWorktree } from '../git/worktrees.js';
import { makeRepo } from '../git/testRepo.js';
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
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from './mcpServer.js';
import { knowledgeSearchFor } from './knowledgeTools.testkit.js';

const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let projects: ProjectRepository;
let harness: FakeHarness;
let worktreesRoot: string;
let repoPath: string;
let projectId: string;
let leadToken: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' });

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
type ToolResult = { content: { text: string }[]; isError?: boolean };
const textOf = (result: unknown): string => (result as ToolResult).content[0]!.text;
const jsonOf = <T = Record<string, unknown>>(result: unknown): T => JSON.parse(textOf(result)) as T;
const isError = (result: unknown): boolean => (result as ToolResult).isError === true;

const tokenOfLaunch = (index: number): string => harness.launches[index]!.mcpToken;
async function startSession(options: { directory: string; role?: string; parentId?: string; projectId?: string }): Promise<{ id: string; token: string }> {
  const session = await sessions.create({ directory: options.directory, name: `S${harness.launches.length}`, harness: 'fake', emoji: '🤖', role: options.role, parentId: options.parentId, projectId: options.projectId });
  return { id: session.id, token: tokenOfLaunch(harness.launches.length - 1) };
}

function aHookScript(body: string, mode = 0o700): string {
  const path = join(tempDirs.make('of-mcp-hook-'), 'hook.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}
const configureHook = (script: string, timeoutSeconds?: number) => projects.update(projectId, { postCreateHookScript: script, ...(timeoutSeconds !== undefined && { postCreateHookTimeoutSeconds: timeoutSeconds }) });
const aWorktree = async (branchName: string): Promise<string> => realpathSync((await createWorktree({ repoPath, branchName, worktreesRoot })).path);

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  worktreesRoot = realpathSync(tempDirs.make('of-mcp-wt-'));
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  const modelTable = { ...DEFAULT_MODEL_TABLE };
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ knowledgeSearch: knowledgeSearchFor(db),
      sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, worktreesRoot,
      workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: tempDirs.make('of-mcp-state-'), maxBytes: 6144 }),
    }),
  });
  projectId = newId();
  projects.insert({ id: projectId, name: 'Fleet', docsFolderPath: null, createdAt: 'now' });
  repoPath = realpathSync(makeRepo());
  leadToken = (await startSession({ directory: repoPath, projectId })).token;
});
afterEach(async () => {
  await sessions.closeAll();
  await server.close();
  tempDirs.removeAll();
});

describe('create_worktree and the project post-create hook', () => {
  const createWorktreeTool = async (branchName: string, token = leadToken) =>
    (await connect(token)).callTool({ name: 'create_worktree', arguments: { repo_path: repoPath, branch_name: branchName } });

  it('answers path and branch alone, without a warnings field, when no hook is configured', async () => {
    const result = await createWorktreeTool('task/plain');

    expect(isError(result)).toBe(false);
    expect(jsonOf(result)).toEqual({ path: join(worktreesRoot, 'task-plain'), branch: 'task/plain' });
  });

  it('runs the project hook inside the new worktree and answers no warning when it succeeds', async () => {
    const marker = join(tempDirs.make('of-mcp-out-'), 'cwd.txt');
    configureHook(aHookScript(`pwd -P > "${marker}"\nenv | grep '^OPENFLEET_' >> "${marker}"`));

    const result = await createWorktreeTool('task/hooked');

    expect(jsonOf(result)).toEqual({ path: join(worktreesRoot, 'task-hooked'), branch: 'task/hooked' });
    const [workingDirectory, ...variables] = readFileSync(marker, 'utf8').trim().split('\n');
    expect(workingDirectory).toBe(realpathSync(join(worktreesRoot, 'task-hooked')));
    expect(variables).toContain('OPENFLEET_BRANCH=task/hooked');
    expect(variables).toContain(`OPENFLEET_PROJECT_ID=${projectId}`);
  });

  it('still creates the worktree and reports a warning when the hook exits non-zero', async () => {
    configureHook(aHookScript('echo "npm install failed" >&2\nexit 3'));

    const result = await createWorktreeTool('task/failing');

    expect(isError(result)).toBe(false);
    const created = jsonOf<{ path: string; branch: string; warnings: { type: string; reason: string; exitCode: number; outputTail: string }[] }>(result);
    expect(created).toMatchObject({ path: join(worktreesRoot, 'task-failing'), branch: 'task/failing' });
    expect(created.warnings).toEqual([{ type: 'post_create_hook_failed', reason: 'exit_nonzero', exitCode: 3, outputTail: expect.stringContaining('npm install failed') }]);
    expect(existsSync(join(created.path, '.git'))).toBe(true);
  });

  it('still creates the worktree and reports a timeout when the hook runs past its timeout', async () => {
    configureHook(aHookScript('sleep 30'), 1);

    const result = await createWorktreeTool('task/slow');

    expect(isError(result)).toBe(false);
    expect(jsonOf<{ warnings: { reason: string }[] }>(result).warnings).toMatchObject([{ reason: 'timeout' }]);
    expect(existsSync(join(worktreesRoot, 'task-slow', '.git'))).toBe(true);
  }, 20_000);

  it('still creates the worktree and reports not_found when the configured script has gone', async () => {
    const script = aHookScript('exit 0');
    configureHook(script);
    rmSync(script);

    const result = await createWorktreeTool('task/gone');

    expect(isError(result)).toBe(false);
    expect(jsonOf<{ warnings: { reason: string }[] }>(result).warnings).toMatchObject([{ reason: 'not_found' }]);
    expect(existsSync(join(worktreesRoot, 'task-gone', '.git'))).toBe(true);
  });

  it('still creates the worktree and reports not_executable when the script lost its execute bit', async () => {
    const script = aHookScript('exit 0');
    configureHook(script);
    chmodSync(script, 0o600);

    const result = await createWorktreeTool('task/noexec');

    expect(isError(result)).toBe(false);
    expect(jsonOf<{ warnings: { reason: string }[] }>(result).warnings).toMatchObject([{ reason: 'not_executable' }]);
    expect(existsSync(join(worktreesRoot, 'task-noexec', '.git'))).toBe(true);
  });

  it('does not run the hook of a project the caller does not belong to', async () => {
    const marker = join(tempDirs.make('of-mcp-out-'), 'ran.txt');
    configureHook(aHookScript(`touch "${marker}"`));
    const outsider = await startSession({ directory: repoPath });

    await createWorktreeTool('task/outsider', outsider.token);

    expect(existsSync(marker)).toBe(false);
  });

  it('does not run the hook when the worktree could not be created', async () => {
    const marker = join(tempDirs.make('of-mcp-out-'), 'ran.txt');
    configureHook(aHookScript(`touch "${marker}"`));
    await createWorktreeTool('task/twice');
    rmSync(marker, { force: true });

    const second = await createWorktreeTool('task/twice');

    expect(isError(second)).toBe(true);
    expect(textOf(second)).toContain('worktree_exists');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('list_worktrees', () => {
  it('lists the worktrees of the caller repository by default', async () => {
    const linked = await aWorktree('task/listed');
    const client = await connect(leadToken);

    const result = await client.callTool({ name: 'list_worktrees', arguments: {} });

    const list = jsonOf<WorktreeList>(result);
    expect(list.items.map((entry) => entry.path)).toEqual([repoPath, linked]);
    expect(list.items[1]).toMatchObject({ branch: 'task/listed', removable: true });
  });

  it('filters with query on repository, branch or path', async () => {
    await aWorktree('feature/alpha');
    await aWorktree('bugfix/beta');
    const client = await connect(leadToken);

    const result = await client.callTool({ name: 'list_worktrees', arguments: { query: 'ALPHA' } });

    expect(jsonOf<WorktreeList>(result).items.map((entry) => entry.branch)).toEqual(['feature/alpha']);
  });

  it('refuses the repository of someone else with outside_own_repository', async () => {
    const otherRepo = realpathSync(makeRepo());
    const client = await connect(leadToken);

    const result = await client.callTool({ name: 'list_worktrees', arguments: { repo_path: otherRepo } });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('error outside_own_repository');
  });
});

describe('remove_worktree', () => {
  const removeTool = async (token: string, path: string, repo = repoPath) =>
    (await connect(token)).callTool({ name: 'remove_worktree', arguments: { repo_path: repo, path } });

  it('lets a root session remove a clean worktree, keeps the branch and answers what went', async () => {
    const linked = await aWorktree('task/clean');

    const result = await removeTool(leadToken, linked);

    expect(isError(result)).toBe(false);
    expect(jsonOf<RemovedWorktree>(result)).toEqual({ removed: linked, branch: 'task/clean', ignoredFileCount: 0 });
    expect(existsSync(linked)).toBe(false);
    expect(git(repoPath, 'branch', '--list', 'task/clean')).toContain('task/clean');
  });

  it('lets a manager remove a clean worktree of its own repository', async () => {
    const lead = await startSession({ directory: repoPath });
    const manager = await startSession({ directory: repoPath, role: MANAGER_ROLE, parentId: (await sessions.list().find((s) => s.name === 'S0'))!.id });
    const linked = await aWorktree('task/by-manager');

    const result = await removeTool(manager.token, linked);

    expect(isError(result)).toBe(false);
    expect(existsSync(linked)).toBe(false);
    expect(lead.id).toBeTruthy();
  });

  it('refuses a plain child session with not_a_manager and removes nothing', async () => {
    const lead = sessions.list().find((s) => s.name === 'S0')!;
    const child = await startSession({ directory: repoPath, parentId: lead.id });
    const linked = await aWorktree('task/by-child');

    const result = await removeTool(child.token, linked);

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('error not_a_manager');
    expect(existsSync(linked)).toBe(true);
  });

  it('refuses the repository of someone else with outside_own_repository and removes nothing', async () => {
    const otherRepo = realpathSync(makeRepo());
    const foreign = realpathSync((await createWorktree({ repoPath: otherRepo, branchName: 'task/foreign', worktreesRoot })).path);

    const result = await removeTool(leadToken, foreign, otherRepo);

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('error outside_own_repository');
    expect(existsSync(foreign)).toBe(true);
  });

  it('refuses a worktree used by a live session with directory_in_use', async () => {
    const linked = await aWorktree('task/busy');
    await startSession({ directory: linked });

    const result = await removeTool(leadToken, linked);

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('error directory_in_use');
    expect(existsSync(linked)).toBe(true);
  });

  it.each([
    ['dirty', (_linked: string) => undefined],
    ['detached', (linked: string) => git(linked, 'checkout', '--detach')],
    ['locked', (linked: string) => git(repoPath, 'worktree', 'lock', linked)],
  ])('refuses a %s worktree with constraint_violation naming the reason, and keeps it', async (reason, makeUnsafe) => {
    const linked = await aWorktree(`task/${reason}`);
    if (reason === 'dirty') writeFileSync(join(linked, 'wip.txt'), 'x');
    makeUnsafe(linked);

    const result = await removeTool(leadToken, linked);

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('error constraint_violation');
    expect(textOf(result)).toContain(`reason: ${reason}`);
    expect(textOf(result)).not.toContain(linked);
    expect(existsSync(linked)).toBe(true);
  });

  it('refuses the main worktree', async () => {
    const result = await removeTool(leadToken, repoPath);

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('reason: main');
    expect(existsSync(join(repoPath, '.git'))).toBe(true);
  });

  it('says plainly in the tool description that ignored files are deleted with the worktree', async () => {
    const client = await connect(leadToken);

    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'remove_worktree')?.description ?? '';

    expect(description).toMatch(/ignored files/i);
    expect(description).toContain('node_modules');
    expect(description).toContain('.env');
    expect(description).toMatch(/never deletes the branch/i);
  });
});
