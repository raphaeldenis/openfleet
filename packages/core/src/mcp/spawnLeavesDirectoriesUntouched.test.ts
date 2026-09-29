import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
      if (statSync(path).isDirectory()) walk(path);
      else files[path] = readFileSync(path, 'utf8');
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
    const { SessionService } = await import('../sessions/sessionService.js');
    const { createMcpHandler } = await import('./mcpServer.js');

    mkdirSync(WORKTREES_ROOT, { recursive: true });
    managerDirectory = mkdtempSync(join(WORKTREES_ROOT, 'manager-'));
    firstChildDirectory = mkdtempSync(join(WORKTREES_ROOT, 'first-'));
    secondChildDirectory = mkdtempSync(join(WORKTREES_ROOT, 'second-'));
    for (const directory of [managerDirectory, firstChildDirectory, secondChildDirectory]) seedProjectSettings(directory);

    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [new ClaudeCliHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: WORKTREES_ROOT, submitKeystrokeDelayMs: 0 });
    const managerRepo = new ManagerRepository(db);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
    const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
    const approvals = new ApprovalService({ db, bus });
    const modelTable = { ...DEFAULT_MODEL_TABLE };
    const server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: WORKTREES_ROOT }) });
    close = () => server.close();

    await sessions.create({ directory: managerDirectory, name: 'Lead', harness: 'claude-cli', emoji: '🧭' });
    const managerMcpConfig = JSON.parse(argAfter(spawn.mock.calls[0]![1], '--mcp-config'));
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

  it('user can spawn two children that each get their own generated settings, passed inline and not shared with the manager', async () => {
    await callCreateSession(firstChildDirectory, 'First');
    await callCreateSession(secondChildDirectory, 'Second');

    const [managerLaunch, firstLaunch, secondLaunch] = spawn.mock.calls.map(([, args]) => argAfter(args, '--settings'));

    expect(new Set([managerLaunch, firstLaunch, secondLaunch]).size).toBe(3);
    for (const inlineSettings of [managerLaunch, firstLaunch, secondLaunch]) expect(() => JSON.parse(inlineSettings!)).not.toThrow();
  });
});
