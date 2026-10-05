import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
mkdirSync(WORKTREES_ROOT, { recursive: true });

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let harness: FakeHarness;
let managerDirectory: string;
let managerToken: string;
let createdDirectories: string[] = [];

const makeTrackedDirectory = (prefix: string) => {
  const directory = mkdtempSync(join(WORKTREES_ROOT, `${prefix}-`));
  createdDirectories.push(directory);
  return directory;
};

beforeEach(async () => {
  managerDirectory = makeTrackedDirectory('qe-manager');
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
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: WORKTREES_ROOT }) });
  await sessions.create({ directory: managerDirectory, name: 'Lead', harness: 'fake', emoji: '🧭' });
  managerToken = harness.launches[0]!.mcpToken;
});
afterEach(async () => {
  await server.close();
  for (const directory of createdDirectories) {
    try { chmodSync(directory, 0o755); } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true });
  }
  createdDirectories = [];
});

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
type ToolResult = { isError?: boolean; content: { text: string }[] };
const create = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: 'create_session', arguments: args })) as ToolResult;
const text = (result: ToolResult) => result.content[0]!.text;

describe('duplicate spawn guard, hostile probes (QE STATE-01k1)', () => {
  it('user can spawn only one child when two create_session calls with the same name run at the same time', async () => {
    const manager = await connect(managerToken);

    const [first, second] = await Promise.all([
      create(manager, { directory: makeTrackedDirectory('race-a'), name: 'Racer' }),
      create(manager, { directory: makeTrackedDirectory('race-b'), name: 'Racer' }),
    ]);

    const liveRacers = sessions.list().filter((s) => s.name === 'Racer' && s.state !== 'closed');
    expect([first.isError, second.isError].filter(Boolean)).toHaveLength(1);
    expect(liveRacers).toHaveLength(1);
  });

  it('user can spawn only one child when two create_session calls target the same directory at the same time', async () => {
    const manager = await connect(managerToken);
    const shared = makeTrackedDirectory('race-shared');

    await Promise.all([create(manager, { directory: shared, name: 'RacerOne' }), create(manager, { directory: shared, name: 'RacerTwo' })]);

    expect(sessions.list().filter((s) => s.parentId !== undefined && s.state !== 'closed')).toHaveLength(1);
  });

  it('user can be refused when the name differs only by surrounding whitespace', async () => {
    const manager = await connect(managerToken);
    await create(manager, { directory: makeTrackedDirectory('a'), name: 'Builder' });

    const result = await create(manager, { directory: makeTrackedDirectory('b'), name: ' Builder ' });

    expect(result.isError).toBe(true);
  });

  it('user can be refused when the name differs only by unicode normalisation form', async () => {
    const manager = await connect(managerToken);
    await create(manager, { directory: makeTrackedDirectory('a'), name: 'Café' });

    const result = await create(manager, { directory: makeTrackedDirectory('b'), name: 'Café' });

    expect(result.isError).toBe(true);
  });

  it('user can be refused when a closed child is reopened and the same name is spawned again', async () => {
    const manager = await connect(managerToken);
    const first = JSON.parse(text(await create(manager, { directory: makeTrackedDirectory('a'), name: 'Builder' }))) as { id: string };
    await manager.callTool({ name: 'close_session', arguments: { session_id: first.id } });
    sessions.reopen(first.id);

    const result = await create(manager, { directory: makeTrackedDirectory('b'), name: 'Builder' });

    expect(result.isError).toBe(true);
  });

  it.each([['string true', 'true'], ['number 1', 1], ['null', null]])('user can not lift the duplicate refusal with allow_duplicate given as %s', async (_label, value) => {
    const manager = await connect(managerToken);
    await create(manager, { directory: makeTrackedDirectory('a'), name: 'Builder' });

    const result = await create(manager, { directory: makeTrackedDirectory('b'), name: 'Builder', allow_duplicate: value });

    expect(result.isError).toBe(true);
    expect(harness.launches).toHaveLength(2);
  });

  it('user can be refused with a readable error when the name is only whitespace', async () => {
    const manager = await connect(managerToken);

    const result = await create(manager, { directory: makeTrackedDirectory('a'), name: '   ' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('name must not be blank');
    expect(harness.launches).toHaveLength(1);
  });

  it('user can spawn a child whose name is 100000 characters long without crashing the guard', async () => {
    const manager = await connect(managerToken);
    const name = 'x'.repeat(100_000);

    await create(manager, { directory: makeTrackedDirectory('a'), name });
    const second = await create(manager, { directory: makeTrackedDirectory('b'), name });

    expect(second.isError).toBe(true);
  });

  it('user can be refused with a duplicate answer when the same directory is requested under a different name', async () => {
    const manager = await connect(managerToken);
    const shared = makeTrackedDirectory('shared');
    await create(manager, { directory: shared, name: 'Builder' });

    const result = await create(manager, { directory: shared, name: 'Other' });

    expect(text(result)).toContain('same directory');
  });

  it('user can spawn into the directory of a live grandchild, since only direct children count as duplicates', async () => {
    const manager = await connect(managerToken);
    const childDirectory = makeTrackedDirectory('child');
    await create(manager, { directory: childDirectory, name: 'Middle' });
    const middle = await connect(harness.launches[1]!.mcpToken);
    const grandDirectory = makeTrackedDirectory('grand');
    await create(middle, { directory: grandDirectory, name: 'Leaf' });

    const result = await create(manager, { directory: grandDirectory, name: 'Other' });

    expect(result.isError).toBeFalsy();
  });

  it('user can be refused by the ancestor guard when an alias of the caller directory is requested while that directory is unreadable', async () => {
    const manager = await connect(managerToken);
    const alias = join(makeTrackedDirectory('alias'), 'link');
    symlinkSync(managerDirectory, alias);
    chmodSync(managerDirectory, 0o000);

    const result = await create(manager, { directory: alias, name: 'Blocked' });
    chmodSync(managerDirectory, 0o755);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('which is you or one of your ancestors');
    expect(harness.launches).toHaveLength(1);
  });
});
