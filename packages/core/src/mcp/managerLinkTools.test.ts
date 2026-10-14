import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
import { governanceQueueFor } from '../governance/governanceQueueFor.testkit.js';

const OWN_PROJECT_ID = 'p1';
const OTHER_PROJECT_ID = 'p2';
const OWN_STORE_ID = 'store-own';
const OTHER_PROJECT_STORE_ID = 'store-other-project';
const CLOCK_TIME = '2026-01-01T00:00:00.000Z';

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let managerRepo: ManagerRepository;
let leadToken: string;
let siblingLeadToken: string;
let leadId: string;
let siblingLeadId: string;
let plainChildToken: string;

const connect = async (token: string) => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};
const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const logStoreOf = (managerId: string) => managerRepo.get(managerId)?.logStoreId;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const storeRepo = new DataStoreRepository(db);
  const noteRepo = new NoteRepository(db);
  const managers = new ManagerService({
    managers: managerRepo, sessions, bus, scheduler: pulseScheduler,
    linkTargets: { noteProjectId: (noteId) => noteRepo.getProjectId(noteId), storeProjectId: (storeId) => storeRepo.findStore(storeId)?.projectId },
  });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };

  const projects = new ProjectRepository(db);
  projects.insert({ id: OWN_PROJECT_ID, name: 'Own', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: OTHER_PROJECT_ID, name: 'Other', docsFolderPath: null, createdAt: 't1' });
  storeRepo.createStore({ id: OWN_STORE_ID, projectId: OWN_PROJECT_ID, displayName: 'Lead log', at: CLOCK_TIME });
  storeRepo.createStore({ id: OTHER_PROJECT_STORE_ID, projectId: OTHER_PROJECT_ID, displayName: 'Foreign log', at: CLOCK_TIME });
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => CLOCK_TIME, newId });
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK_TIME, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK_TIME });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ knowledgeSearch: knowledgeSearchFor(db), governanceQueue: governanceQueueFor(db),
      sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, projects,
      workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }),
    }),
  });

  const aManagerOfOwnProject = async (name: string) => {
    const session = await managers.createManagerSession({ directory: '/tmp', name, emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship' } } as never);
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(OWN_PROJECT_ID, session.id);
    return session.id;
  };
  leadId = await aManagerOfOwnProject('Lead');
  siblingLeadId = await aManagerOfOwnProject('Sibling lead');
  const plainChild = await sessions.create({ directory: '/tmp', name: 'Gimli', emoji: '⛏️', harness: 'fake', parentId: leadId });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(OWN_PROJECT_ID, plainChild.id);
  [leadToken, siblingLeadToken] = [harness.launches[0]!.mcpToken, harness.launches[1]!.mcpToken];
  plainChildToken = harness.launches[2]!.mcpToken;
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe('set_argus_log_store', () => {
  it('is offered to an agent', async () => {
    const client = await connect(leadToken);

    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);

    expect(toolNames).toContain('set_argus_log_store');
  });

  it('binds a table of the manager\'s own project to the calling manager', async () => {
    const client = await connect(leadToken);

    const result = await client.callTool({ name: 'set_argus_log_store', arguments: { store_id: OWN_STORE_ID } });

    expect(JSON.parse(textOf(result))).toEqual({ logStoreId: OWN_STORE_ID });
    expect(logStoreOf(leadId)).toBe(OWN_STORE_ID);
  });

  it('binds only the calling manager and leaves a sibling manager unbound', async () => {
    const client = await connect(leadToken);

    await client.callTool({ name: 'set_argus_log_store', arguments: { store_id: OWN_STORE_ID } });

    expect(logStoreOf(siblingLeadId)).toBeUndefined();
  });

  it('each manager binds its own table without touching the other', async () => {
    const lead = await connect(leadToken);
    const siblingLead = await connect(siblingLeadToken);
    db.prepare("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('store-sibling', ?, 'Sibling log', ?, ?)").run(OWN_PROJECT_ID, CLOCK_TIME, CLOCK_TIME);

    await lead.callTool({ name: 'set_argus_log_store', arguments: { store_id: OWN_STORE_ID } });
    await siblingLead.callTool({ name: 'set_argus_log_store', arguments: { store_id: 'store-sibling' } });

    expect([logStoreOf(leadId), logStoreOf(siblingLeadId)]).toEqual([OWN_STORE_ID, 'store-sibling']);
  });

  it('refuses a session that is not a manager and binds nothing', async () => {
    const client = await connect(plainChildToken);

    const result = await client.callTool({ name: 'set_argus_log_store', arguments: { store_id: OWN_STORE_ID } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not_a_manager');
    expect(logStoreOf(leadId)).toBeUndefined();
  });

  it('refuses a table that does not exist', async () => {
    const client = await connect(leadToken);

    const result = await client.callTool({ name: 'set_argus_log_store', arguments: { store_id: 'no-such-store' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('store_not_found');
    expect(logStoreOf(leadId)).toBeUndefined();
  });

  it('refuses a table of another project with the very words used for a missing table', async () => {
    const client = await connect(leadToken);

    const foreign = await client.callTool({ name: 'set_argus_log_store', arguments: { store_id: OTHER_PROJECT_STORE_ID } });
    const missing = await client.callTool({ name: 'set_argus_log_store', arguments: { store_id: 'no-such-store' } });

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe(textOf(missing));
    expect(logStoreOf(leadId)).toBeUndefined();
  });
});
