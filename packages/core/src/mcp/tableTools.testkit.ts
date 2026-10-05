import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DatabaseSync } from 'node:sqlite';
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

const CLOCK_TIME = '2026-01-01T00:00:00.000Z';

export interface ToolOutcome {
  isError: boolean;
  /** The raw text an agent reads. */
  text: string;
  /** The parsed payload of a successful call. */
  json: any;
}

export interface TableToolsKit {
  db: DatabaseSync;
  stores: DataStoreService;
  storeRepo: DataStoreRepository;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  listTools: () => Promise<{ name: string; description?: string | undefined }[]>;
  close: () => Promise<void>;
}

/** An in-memory daemon with one session scoped to project p1, driven through the MCP tool surface an agent sees. */
export async function startTableToolsKit(): Promise<TableToolsKit> {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };

  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  const storeRepo = new DataStoreRepository(db);
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => CLOCK_TIME, newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK_TIME, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK_TIME });
  const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 });

  const server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, projects, workingStates }),
  });

  const scoped = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', scoped.id);
  const scopedToken = harness.launches[0]!.mcpToken;

  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${scopedToken}` } } }));

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const result = await client.callTool({ name, arguments: args });
    const { text } = (result.content as { text: string }[])[0]!;
    const isError = result.isError === true;
    return { isError, text, json: isError ? undefined : JSON.parse(text) };
  };

  const listTools = async () => (await client.listTools()).tools;

  return { db, stores, storeRepo, call, listTools, close: async () => { await client.close(); await server.close(); } };
}
