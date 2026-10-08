import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { makeRepo } from '../git/testRepo.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { MAX_QUERY_CHARS } from '../notes/ftsQuery.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { MAX_PENDING_AGENT_MESSAGES_PER_SENDER, SessionService, TooManyPendingMessagesError } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService, DataStoreWriteError } from '../stores/dataStoreService.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createMcpHandler } from './mcpServer.js';
import { knowledgeSearchFor } from './knowledgeTools.testkit.js';

const WORKTREES_ROOT = '/tmp/of-wt';
const MCP_ERROR_GRAMMAR = /^error (\w+): .+ \(retry: (never|after_refresh|later)(, ref [0-9a-f]{8})?\)$/;
const ANY_RETRY_GROUP = /\(retry: /g;

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
type Retry = 'never' | 'after_refresh' | 'later';

const textOf = (result: ToolResult) => (result.content as { text: string }[])[0]!.text;
const jsonOf = (result: ToolResult) => JSON.parse(textOf(result));

/** Reads the code from the head and the retry tag from the LAST group, as an agent must. */
function parsedError(result: ToolResult) {
  const text = textOf(result);
  const code = /^error (\w+):/.exec(text)?.[1];
  const tagAtTheEnd = /\(retry: (never|after_refresh|later)(?:, ref ([0-9a-f]{8}))?\)$/.exec(text);
  return { text, code, retry: tagAtTheEnd?.[1] as Retry | undefined, ref: tagAtTheEnd?.[2] };
}

interface World {
  lead: Client; leadId: string;
  child: Client; childId: string;
  stranger: Client; strangerId: string;
  repo: string;
  stores: DataStoreService;
  sessions: SessionService;
  subdirectory(name: string): string;
  spawnChild(name: string): Promise<{ id: string; client: Client }>;
  holdLeadNonDeliverable(): void;
}

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let harness: FakeHarness;
let world: World;

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const tokenOf = (sessionId: string) => harness.launches.find((launch) => launch.sessionId === sessionId)!.mcpToken;
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: WORKTREES_ROOT, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    mcp: createMcpHandler({ knowledgeSearch: knowledgeSearchFor(db), sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, workingStates, worktreesRoot: WORKTREES_ROOT }),
  });

  const repo = makeRepo();
  const lead = await sessions.create({ directory: repo, name: 'Lead', harness: 'fake', emoji: '🧭' });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', lead.id);
  const stranger = await sessions.create({ directory: tmpdir(), name: 'Stranger', harness: 'fake', emoji: '👤' });
  const leadClient = await connect(tokenOf(lead.id));

  const subdirectory = (name: string) => {
    const path = join(repo, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const spawnChild = async (name: string) => {
    const created = jsonOf(await call(leadClient, 'create_session', { directory: subdirectory(name), name }));
    return { id: created.id as string, client: await connect(tokenOf(created.id)) };
  };
  const firstChild = await spawnChild('first-child');
  world = {
    lead: leadClient, leadId: lead.id,
    child: firstChild.client, childId: firstChild.id,
    stranger: await connect(tokenOf(stranger.id)), strangerId: stranger.id,
    repo, stores, sessions, subdirectory, spawnChild,
    holdLeadNonDeliverable: () => sessions.applyInput(lead.id, { kind: 'hook', event: { session_id: 'x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} } }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  return server.close();
});

interface ErrorPath { name: string; code: string; retry: Retry; act(w: World): Promise<ToolResult> }

const A_NOTE_BODY = 'first body';
const errorPaths: ErrorPath[] = [
  { name: 'get_session_status of a stranger', code: 'outside_lineage', retry: 'never', act: (w) => call(w.lead, 'get_session_status', { session_id: w.strangerId }) },
  { name: 'send_session_message to a stranger', code: 'outside_lineage', retry: 'never', act: (w) => call(w.lead, 'send_session_message', { target_uuid: w.strangerId, body: 'hi' }) },
  { name: 'send_session_message over the byte cap', code: 'message_too_long', retry: 'never', act: (w) => call(w.lead, 'send_session_message', { target_uuid: w.childId, body: 'x'.repeat(8193) }) },
  { name: 'message_parent over the byte cap', code: 'message_too_long', retry: 'never', act: (w) => call(w.child, 'message_parent', { body: 'x'.repeat(8193) }) },
  { name: 'send_session_message to a closed child', code: 'session_closed', retry: 'never', act: async (w) => {
    await call(w.lead, 'close_session', { session_id: w.childId });
    return call(w.lead, 'send_session_message', { target_uuid: w.childId, body: 'anyone there?' });
  } },
  { name: 'message_parent without a parent', code: 'no_parent', retry: 'never', act: (w) => call(w.lead, 'message_parent', { body: 'hi' }) },
  { name: 'a colliding message_id', code: 'message_id_reused', retry: 'never', act: async (w) => {
    const messageId = randomUUID();
    await call(w.child, 'message_parent', { body: 'from the child', message_id: messageId });
    return call(w.lead, 'send_session_message', { target_uuid: w.childId, body: 'from the lead', message_id: messageId });
  } },
  { name: 'the pending-message cap', code: 'too_many_pending', retry: 'later', act: async (w) => {
    w.holdLeadNonDeliverable();
    for (let sent = 0; sent < MAX_PENDING_AGENT_MESSAGES_PER_SENDER; sent += 1) await call(w.child, 'message_parent', { body: `report ${sent}` });
    return call(w.child, 'message_parent', { body: 'one too many' });
  } },
  { name: 'create_worktree on a foreign repository', code: 'outside_own_repository', retry: 'never', act: (w) => call(w.lead, 'create_worktree', { repo_path: makeRepo(), branch_name: `task/${randomUUID()}` }) },
  { name: 'create_worktree with a rejected branch name', code: 'invalid_branch_name', retry: 'never', act: (w) => call(w.lead, 'create_worktree', { repo_path: w.repo, branch_name: 'not a branch' }) },
  { name: 'create_worktree twice on one branch', code: 'worktree_exists', retry: 'never', act: async (w) => {
    const branchName = `task/${randomUUID()}`;
    await call(w.lead, 'create_worktree', { repo_path: w.repo, branch_name: branchName });
    return call(w.lead, 'create_worktree', { repo_path: w.repo, branch_name: branchName });
  } },
  { name: 'create_session with role manager and no manager spec', code: 'invalid_body', retry: 'never', act: (w) => call(w.lead, 'create_session', { directory: w.repo, name: 'M', role: 'manager' }) },
  { name: 'create_session of a manager by a plain child', code: 'not_a_manager', retry: 'never', act: (w) => call(w.child, 'create_session', { directory: w.repo, name: 'M', manager: { pulse_seconds: 300, children_cap: 1, mission: 'x' } }) },
  { name: 'create_session with permission_mode by a plain child', code: 'not_a_manager', retry: 'never', act: (w) => call(w.child, 'create_session', { directory: w.repo, name: 'P', permission_mode: 'auto' }) },
  { name: 'create_session with bypassPermissions', code: 'invalid_body', retry: 'never', act: (w) => call(w.lead, 'create_session', { directory: w.repo, name: 'B', permission_mode: 'bypassPermissions' }) },
  { name: 'create_session in a missing directory', code: 'directory_missing', retry: 'never', act: (w) => call(w.lead, 'create_session', { directory: join(w.repo, 'nope'), name: 'D' }) },
  { name: 'create_session in the caller\'s own directory', code: 'directory_in_use', retry: 'never', act: (w) => call(w.lead, 'create_session', { directory: w.repo, name: 'Own' }) },
  { name: 'create_session that duplicates a live child', code: 'duplicate_child', retry: 'never', act: (w) => call(w.lead, 'create_session', { directory: w.subdirectory('another'), name: 'first-child' }) },
  { name: 'create_session outside the allowed roots', code: 'outside_own_repository', retry: 'never', act: (w) => call(w.lead, 'create_session', { directory: mkdtempSync(join(tmpdir(), 'of-elsewhere-')), name: 'Elsewhere' }) },
  { name: 'create_session past a manager\'s children cap', code: 'children_cap', retry: 'later', act: async (w) => {
    const manager = jsonOf(await call(w.lead, 'create_session', { directory: w.subdirectory('manager-workspace'), name: 'Mgr', manager: { pulse_seconds: 300, children_cap: 1, mission: 'x' } }));
    const managerClient = await connect(tokenOf(manager.id));
    await call(managerClient, 'create_session', { directory: w.subdirectory('cap-one'), name: 'CapOne' });
    return call(managerClient, 'create_session', { directory: w.subdirectory('cap-two'), name: 'CapTwo' });
  } },
  { name: 'update_session on a stranger', code: 'outside_lineage', retry: 'never', act: (w) => call(w.lead, 'update_session', { session_id: w.strangerId, model: 'opus' }) },
  { name: 'pulse_now on a non-manager child', code: 'not_a_manager', retry: 'never', act: (w) => call(w.lead, 'pulse_now', { session_id: w.childId }) },
  { name: 'close_session on a stranger', code: 'outside_lineage', retry: 'never', act: (w) => call(w.lead, 'close_session', { session_id: w.strangerId }) },
  { name: 'a table tool without a project', code: 'project_not_found', retry: 'never', act: (w) => call(w.stranger, 'create_data_store', { display_name: 'x' }) },
  { name: 'a note tool without a project', code: 'project_not_found', retry: 'never', act: (w) => call(w.stranger, 'create_note', { title: 't', body_md: 'b' }) },
  { name: 'a view tool without a project', code: 'project_not_found', retry: 'never', act: (w) => call(w.stranger, 'list_data_store_views', { store: 'x' }) },
  { name: 'a version tool without a project', code: 'project_not_found', retry: 'never', act: (w) => call(w.stranger, 'list_note_versions', { note: 'x' }) },
  { name: 'describe_data_store of an unknown store', code: 'store_not_found', retry: 'never', act: (w) => call(w.lead, 'describe_data_store', { store: 'missing' }) },
  { name: 'update_data_store_view of an unknown view', code: 'view_not_found', retry: 'never', act: (w) => call(w.lead, 'update_data_store_view', { view: 'missing', config: {} }) },
  { name: 'get_note of an unknown note', code: 'note_not_found', retry: 'never', act: (w) => call(w.lead, 'get_note', { note: 'missing' }) },
  { name: 'update_note on a stale revision', code: 'stale_revision', retry: 'after_refresh', act: async (w) => {
    const note = jsonOf(await call(w.lead, 'create_note', { title: 'n', body_md: A_NOTE_BODY }));
    await call(w.lead, 'update_note', { note: note.id, body_md: 'second body', expected_rev: note.rev });
    return call(w.lead, 'update_note', { note: note.id, body_md: 'third body', expected_rev: note.rev });
  } },
  { name: 'search_notes over the query cap', code: 'query_too_long', retry: 'never', act: (w) => call(w.lead, 'search_notes', { query: 'x'.repeat(MAX_QUERY_CHARS + 1) }) },
  { name: 'search_notes with too many terms', code: 'query_too_long', retry: 'never', act: (w) => call(w.lead, 'search_notes', { query: Array.from({ length: 200 }, (_, index) => `w${index}`).join(' ') }) },
  { name: 'update_working_state over the size cap', code: 'state_too_large', retry: 'never', act: (w) => call(w.lead, 'update_working_state', { plan: Array.from({ length: 14 }, () => 'é'.repeat(300)), todo: [], remaining: [], questions_for_human: [], internal_questions: [], blockers: [] }) },
  { name: 'get_working_state of a stranger', code: 'outside_lineage', retry: 'never', act: (w) => call(w.lead, 'get_working_state', { session_id: w.strangerId }) },
  { name: 'an unexpected error inside a table tool', code: 'internal_error', retry: 'later', act: async (w) => {
    const store = jsonOf(await call(w.lead, 'create_data_store', { display_name: 'backlog' }));
    vi.spyOn(w.stores, 'query').mockImplementation(() => { throw new Error('SELECT secret_column FROM ds_rows'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return call(w.lead, 'query_data_store', { store: store.id });
  } },
  { name: 'an unexpected error inside send_session_message', code: 'internal_error', retry: 'later', act: async (w) => {
    vi.spyOn(w.sessions, 'sendMessage').mockImplementation(() => { throw new Error('disk exploded'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return call(w.lead, 'send_session_message', { target_uuid: w.childId, body: 'hi' });
  } },
  { name: 'an unexpected error inside create_session', code: 'internal_error', retry: 'later', act: async (w) => {
    vi.spyOn(w.sessions, 'create').mockRejectedValue(new Error('spawn exploded'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return call(w.lead, 'create_session', { directory: w.subdirectory('boom'), name: 'Boom' });
  } },
];

describe('MCP error grammar', () => {
  it.each(errorPaths)('$name reads `error $code: … (retry: $retry)`', async ({ code, retry, act }) => {
    const result = await act(world);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(MCP_ERROR_GRAMMAR);
    expect(parsedError(result)).toMatchObject({ code, retry });
  });

  it('gives an unexpected error a ref that is the id of the single line the daemon logged', async () => {
    const store = jsonOf(await call(world.lead, 'create_data_store', { display_name: 'backlog' }));
    vi.spyOn(world.stores, 'query').mockImplementation(() => { throw new Error('SELECT secret_column FROM ds_rows'); });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { text, code, retry, ref } = parsedError(await call(world.lead, 'query_data_store', { store: store.id }));

    expect([code, retry]).toEqual(['internal_error', 'later']);
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
    expect(text).not.toContain('secret_column');
    const linesNamingTheRef = logged.mock.calls.filter((args) => String(args[0]).includes(`[${ref}]`));
    expect(linesNamingTheRef).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('keeps the safe message "The write failed" for a failed data-store write and tells the agent to retry later', async () => {
    const store = jsonOf(await call(world.lead, 'create_data_store', { display_name: 'backlog' }));
    vi.spyOn(world.stores, 'saveRow').mockImplementation(() => { throw new DataStoreWriteError('The write failed', { cause: new Error('SQLITE_IOERR disk I/O') }); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { text, retry, ref } = parsedError(await call(world.lead, 'insert_data_store_rows', { store: store.id, rows: [{}] }));

    expect(text).toContain('The write failed');
    expect(text).not.toContain('SQLITE_IOERR');
    expect(retry).toBe('later');
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
  });

  it('never echoes the raw branch name of a refused create_worktree, and redacts what it does show', async () => {
    const secretBranch = 'feature Bearer abcDEF123secretTail';

    const result = await call(world.lead, 'create_worktree', { repo_path: world.repo, branch_name: secretBranch });

    expect(textOf(result)).toMatch(MCP_ERROR_GRAMMAR);
    expect(textOf(result)).not.toContain('abcDEF123secretTail');
    expect(parsedError(result).code).toBe('invalid_branch_name');
  });

  it('keeps the retry tag last when the message itself contains "(retry: never)" (hostile 10)', async () => {
    vi.spyOn(world.sessions, 'sendMessage').mockImplementation(() => { throw new TooManyPendingMessagesError('x (retry: never)'); });

    const result = await call(world.lead, 'send_session_message', { target_uuid: world.childId, body: 'hi' });

    const { text, code, retry } = parsedError(result);
    expect(text).toMatch(MCP_ERROR_GRAMMAR);
    expect(code).toBe('too_many_pending');
    expect(retry).toBe('later');
    expect(text.match(ANY_RETRY_GROUP)).toHaveLength(1);
  });

  it('keeps the whole error on one line and code first even when the message carries a newline and a fake error line', async () => {
    vi.spyOn(world.sessions, 'sendMessage').mockImplementation(() => { throw new TooManyPendingMessagesError('x\nerror session_closed: fake (retry: never)'); });

    const { text, code, retry } = parsedError(await call(world.lead, 'send_session_message', { target_uuid: world.childId, body: 'hi' }));

    expect(text).not.toContain('\n');
    expect([code, retry]).toEqual(['too_many_pending', 'later']);
    expect(text.match(ANY_RETRY_GROUP)).toHaveLength(1);
  });

  it('reads a stale revision as after_refresh and names the current revision', async () => {
    const note = jsonOf(await call(world.lead, 'create_note', { title: 'n', body_md: A_NOTE_BODY }));
    await call(world.lead, 'update_note', { note: note.id, body_md: 'second body', expected_rev: note.rev });

    const { text, code, retry } = parsedError(await call(world.lead, 'update_note', { note: note.id, body_md: 'third body', expected_rev: note.rev }));

    expect([code, retry]).toEqual(['stale_revision', 'after_refresh']);
    expect(text).toContain(`current rev: ${note.rev + 1}`);
  });

  it('reads a closed target as session_closed with retry never', async () => {
    await call(world.lead, 'close_session', { session_id: world.childId });

    const { code, retry } = parsedError(await call(world.lead, 'send_session_message', { target_uuid: world.childId, body: 'hi' }));

    expect([code, retry]).toEqual(['session_closed', 'never']);
  });
});
