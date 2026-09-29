import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn((_command: string, _args: string[], _options: { cwd: string }) => ({
  onData: () => ({ dispose: () => undefined }),
  onExit: () => ({ dispose: () => undefined }),
  write: vi.fn(),
  resize: () => undefined,
  kill: () => undefined,
}));
vi.mock('node-pty', () => ({ spawn }));
vi.mock('../harness/claudeCli/trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));

const WORKTREES_ROOT = '/tmp/of-wt';
const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'];

function seedProjectSettings(directory: string): void {
  const claudeFolder = join(directory, '.claude');
  mkdirSync(claudeFolder, { recursive: true });
  for (const file of PROJECT_SETTINGS_FILES) writeFileSync(join(claudeFolder, file), JSON.stringify({ owner: directory, file }));
}

function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        files[`${path}/`] = '<directory>';
        walk(path);
      } else files[path] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return files;
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

describe('spawning a child session', () => {
  let close: () => Promise<void>;
  let callCreateSession: (directory: string, name: string) => Promise<unknown>;
  let managerDirectory: string;
  let firstChildDirectory: string;
  let secondChildDirectory: string;
  let openFleetSessionsRoot: string;

  beforeEach(async () => {
    spawn.mockClear();
    const { startServer } = await import('../api/server.js');
    const { openDatabase } = await import('../db/database.js');
    const { EventBus } = await import('../events/eventBus.js');
    const { ApprovalService } = await import('../governance/approvalService.js');
    const { ClaudeCliHarness } = await import('../harness/claudeCli/claudeCliHarness.js');
    const { ManagerRepository } = await import('../managers/managerRepository.js');
    const { ManagerService } = await import('../managers/managerService.js');
    const { PulseScheduler } = await import('../managers/pulseScheduler.js');
    const { DEFAULT_MODEL_TABLE } = await import('../models.js');
    const { DocsFolderService } = await import('../notes/docsFolderService.js');
    const { expandMentions } = await import('../notes/mentionExpander.js');
    const { nodeDocsFolderFs } = await import('../notes/nodeDocsFolderFs.js');
    const { NoteRepository } = await import('../notes/noteRepository.js');
    const { NoteService } = await import('../notes/noteService.js');
    const { ProjectRepository } = await import('../projects/projectRepository.js');
    const { DataStoreRepository } = await import('../stores/dataStoreRepository.js');
    const { DataStoreService } = await import('../stores/dataStoreService.js');
    const { WorkingStateService } = await import('../workingState/workingStateService.js');
    const { newId } = await import('../ids.js');
    const { SessionService } = await import('../sessions/sessionService.js');
    const { createMcpHandler } = await import('./mcpServer.js');

    mkdirSync(WORKTREES_ROOT, { recursive: true });
    managerDirectory = mkdtempSync(join(WORKTREES_ROOT, 'manager-'));
    firstChildDirectory = mkdtempSync(join(WORKTREES_ROOT, 'first-'));
    secondChildDirectory = mkdtempSync(join(WORKTREES_ROOT, 'second-'));
    for (const directory of [managerDirectory, firstChildDirectory, secondChildDirectory]) seedProjectSettings(directory);

    const db = openDatabase(':memory:');
    const bus = new EventBus();
    openFleetSessionsRoot = mkdtempSync(join(tmpdir(), 'of-home-'));
    const sessions = new SessionService({ db, bus, harnesses: [new ClaudeCliHarness(openFleetSessionsRoot)], baseUrl: 'http://127.0.0.1:0', worktreesRoot: WORKTREES_ROOT, submitKeystrokeDelayMs: 0 });
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
    const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: WORKTREES_ROOT }) });
    close = () => server.close();

    await sessions.create({ directory: managerDirectory, name: 'Lead', harness: 'claude-cli', emoji: '🧭' });
    const managerMcpConfig = JSON.parse(readFileSync(argAfter(spawn.mock.calls[0]![1], '--mcp-config'), 'utf8'));
    const managerToken = managerMcpConfig.mcpServers.openfleet.headers.Authorization.replace('Bearer ', '');
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${managerToken}` } } }));
    callCreateSession = (directory, name) => client.callTool({ name: 'create_session', arguments: { directory, name } });
  });
  afterEach(() => close());

  it('user can spawn two children and every file in the manager and child directories keeps its content, project settings included', async () => {
    const directories = [managerDirectory, firstChildDirectory, secondChildDirectory];
    const before = directories.map(snapshotTree);

    await callCreateSession(firstChildDirectory, 'First');
    await callCreateSession(secondChildDirectory, 'Second');

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(directories.map(snapshotTree)).toEqual(before);
  });

  it('user can spawn two children that each get their own generated settings, passed as separate files and not shared with the manager', async () => {
    await callCreateSession(firstChildDirectory, 'First');
    await callCreateSession(secondChildDirectory, 'Second');

    const [managerLaunch, firstLaunch, secondLaunch] = spawn.mock.calls.map(([, args]) => argAfter(args, '--settings'));

    expect(new Set([managerLaunch, firstLaunch, secondLaunch]).size).toBe(3);
    for (const settingsPath of [managerLaunch, firstLaunch, secondLaunch]) expect(() => JSON.parse(readFileSync(settingsPath!, 'utf8'))).not.toThrow();
  });

  it('user can spawn a child whose settings and mcp config live in a 0700 folder of the OpenFleet home, mode 0600, and in no working directory', async () => {
    await callCreateSession(firstChildDirectory, 'First');

    const workingDirectories = [managerDirectory, firstChildDirectory, secondChildDirectory].map((directory) => realpathSync(directory));
    const openFleetHome = realpathSync(openFleetSessionsRoot);
    for (const [, args] of spawn.mock.calls) {
      for (const generatedFile of [argAfter(args, '--settings'), argAfter(args, '--mcp-config')]) {
        const realFile = realpathSync(generatedFile);
        const folder = dirname(realFile);
        expect(realFile.startsWith(`${openFleetHome}/`)).toBe(true);
        for (const workingDirectory of workingDirectories) expect(realFile.startsWith(`${workingDirectory}/`)).toBe(false);
        expect(statSync(realFile).mode & 0o777).toBe(0o600);
        expect(statSync(folder).mode & 0o777).toBe(0o700);
      }
    }
  });

  it('user can spawn two children and neither shares a generated settings folder with the manager or the other child', async () => {
    await callCreateSession(firstChildDirectory, 'First');
    await callCreateSession(secondChildDirectory, 'Second');

    const settingsFolders = spawn.mock.calls.map(([, args]) => dirname(argAfter(args, '--settings')));
    const mcpConfigFolders = spawn.mock.calls.map(([, args]) => dirname(argAfter(args, '--mcp-config')));

    expect(new Set(settingsFolders).size).toBe(3);
    expect(mcpConfigFolders).toEqual(settingsFolders);
  });
});
