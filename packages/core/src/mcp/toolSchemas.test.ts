import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'node:module';
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
import { newId } from '../ids.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from './mcpServer.js';

// ajv is the MCP SDK's own transitive validator; resolving it through the SDK avoids a new dependency.
const requireFromSdk = createRequire(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/package.json'));
const Ajv2020 = requireFromSdk('ajv/dist/2020.js').default as new (options: object) => {
  validateSchema(schema: object): boolean | Promise<unknown>;
  compile(schema: object): unknown;
  errorsText(): string;
};

const ACCEPTED_DRAFTS = ['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#'];
const DRAFT_4_AND_7_ONLY_KEYWORDS = ['definitions', 'nullable', 'dependencies', 'additionalItems'];

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let parentToken: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
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
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json', mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }), worktreesRoot: '/tmp/of-wt' }) });
  await sessions.create({ directory: '/tmp', name: 'Lead', harness: 'fake', emoji: '🧭' });
  parentToken = harness.launches[0]!.mcpToken;
});
afterEach(() => server.close());

async function listToolSchemas(): Promise<{ name: string; inputSchema: Record<string, unknown> }[]> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${parentToken}` } } }));
  const { tools } = await client.listTools();
  return tools;
}

function collectNodes(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((child) => collectNodes(child, found));
  else if (node !== null && typeof node === 'object') {
    found.push(node as Record<string, unknown>);
    Object.values(node).forEach((child) => collectNodes(child, found));
  }
  return found;
}

describe('MCP tool input schemas', () => {
  it('every tool advertises an input schema a JSON Schema 2020-12 validator accepts', async () => {
    const tools = await listToolSchemas();
    const ajv = new Ajv2020({ strict: false });

    const offenders = tools.flatMap(({ name, inputSchema }) => {
      const { $schema: _sdkDefaultDraft, ...schemaJudgedAs2020 } = inputSchema;
      const isMetaschemaValid = ajv.validateSchema(schemaJudgedAs2020) === true;
      if (!isMetaschemaValid) return [`${name}: ${ajv.errorsText()}`];
      try {
        ajv.compile(schemaJudgedAs2020);
        return [];
      } catch (error) {
        return [`${name}: ${(error as Error).message}`];
      }
    });

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_working_state', 'update_working_state']));
    expect(offenders).toEqual([]);
  });

  it('every tool pattern compiles under both the u and the v regex flags', async () => {
    const tools = await listToolSchemas();

    const offenders = tools.flatMap(({ name, inputSchema }) =>
      collectNodes(inputSchema)
        .map((node) => node.pattern)
        .filter((pattern): pattern is string => typeof pattern === 'string')
        .flatMap((pattern) => ['u', 'v'].flatMap((flags) => {
          try {
            new RegExp(pattern, flags);
            return [];
          } catch (error) {
            return [`${name}: /${pattern}/${flags} ${(error as Error).message}`];
          }
        })),
    );

    expect(offenders).toEqual([]);
  });

  it('no tool schema uses a keyword or $schema from another draft', async () => {
    const tools = await listToolSchemas();

    const offenders = tools.flatMap(({ name, inputSchema }) =>
      collectNodes(inputSchema).flatMap((node) => {
        const wrongDraft = typeof node.$schema === 'string' && !ACCEPTED_DRAFTS.includes(node.$schema) ? [`${name}: $schema ${node.$schema}`] : [];
        const oldKeywords = DRAFT_4_AND_7_ONLY_KEYWORDS.filter((keyword) => keyword in node).map((keyword) => `${name}: ${keyword}`);
        const booleanExclusive = ['exclusiveMinimum', 'exclusiveMaximum'].filter((keyword) => typeof node[keyword] === 'boolean').map((keyword) => `${name}: boolean ${keyword}`);
        return [...wrongDraft, ...oldKeywords, ...booleanExclusive];
      }),
    );

    expect(offenders).toEqual([]);
  });
});
