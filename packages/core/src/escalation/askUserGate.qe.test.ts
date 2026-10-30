import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const TICKET = 'CCM-123';
const FREE_TEXT_QUESTION = 'which of the two helpers do you prefer?';
const JOURNAL_KIND = 'question_unclassified';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;

let daemon: Daemon;
let adminToken: string;
let worktreesRoot: string;
let clients: Client[];
const directories = createTempDirTracker();

const rawText = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));
const tokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const hookTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;

const adminApi = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...options.headers },
});

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'ask-user-gate-qe', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenOf(sessionId)}` } } }));
  return client;
}

async function spawn(parent: Client, extra: Json = {}): Promise<{ id: string; client: Client }> {
  const directory = join(worktreesRoot, `child-${randomUUID()}`);
  mkdirSync(directory);
  const created = parsed(await parent.callTool({ name: 'create_session', arguments: { directory, name: 'Spawned', allow_duplicate: true, ...extra } }));
  return { id: created.id as string, client: await connect(created.id) };
}

async function aNote(title: string): Promise<{ id: string }> {
  const response = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title, bodyMd: `# ${title}\n\n## Plan\n\nthe plan` }) });
  const created = (await response.json()) as { id?: string; data?: { id: string } };
  return { id: created.id ?? created.data!.id };
}

async function bootManager() {
  const root = await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: worktreesRoot, name: 'Root', harness: 'fake', emoji: '🤖', projectId: PROJECT_ID }) });
  const rootClient = await connect(((await root.json()) as { id: string }).id);
  const manager = await spawn(rootClient, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 } });
  await manager.client.callTool({ name: 'get_manager_base', arguments: {} });
  await manager.client.callTool({ name: 'bootstrap_project_profile', arguments: {} });
  const planNote = await aNote('Plan');
  return { rootClient, manager, planNote };
}

const askHuman = (client: Client, questions: string[]) => client.callTool({ name: 'update_working_state', arguments: { plan: [], todo: [], remaining: [], questions_for_human: questions, internal_questions: [], blockers: [] } });
const setAskUserGate = (askUserGate: string) => adminApi(`/api/projects/${PROJECT_ID}`, { method: 'PATCH', body: JSON.stringify({ escalation: { askUserGate } }) });

const journalLinesOfKind = (kind: string): Json[] => (daemon.db.prepare('SELECT data_json FROM ds_rows ORDER BY rowid').all() as { data_json: string }[])
  .map(({ data_json }) => JSON.parse(data_json) as Json)
  .filter((cells) => Object.values(cells).some((value) => typeof value === 'string' && value.includes(kind)));
const textOf = (line: Json) => Object.values(line).filter((value): value is string => typeof value === 'string').join(' | ');
const unclassifiedRows = () => daemon.db.prepare("SELECT session_id, manager_id, role, outcome, tool_name, command_excerpt FROM denied_commands WHERE rule_id = 'question-unclassified' ORDER BY rowid").all() as Record<string, unknown>[];
const questionsForHumanOf = (managerId: string): string[] => {
  const row = daemon.db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(managerId) as { sections_json: string } | undefined;
  return row ? (JSON.parse(row.sections_json) as { questionsForHuman: string[] }).questionsForHuman : [];
};
const askUserQuestionByHook = (sessionId: string) => fetch(`${daemon.server.url}/hooks/${hookTokenOf(sessionId)}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } }),
});

function seedProjectWithJournal(dbPath: string): void {
  const db = openDatabase(dbPath);
  new ProjectRepository(db).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  const scope = { projectId: PROJECT_ID };
  const stores = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => new Date().toISOString(), newId: randomUUID });
  const backlog = stores.createStore({ ...scope, displayName: 'Manager backlog' });
  const ticketColumn = stores.addColumn(backlog.id, { ...scope, displayName: 'Ticket', columnType: 'text' });
  stores.setNaturalKey(backlog.id, { ...scope, columnId: ticketColumn.id });
  const journal = stores.createStore({ ...scope, displayName: 'Manager journal' });
  stores.addColumn(journal.id, { ...scope, displayName: 'Entry', columnType: 'text' });
  stores.addColumn(journal.id, { ...scope, displayName: 'Author', columnType: 'text' });
  db.close();
}

beforeEach(async () => {
  clients = [];
  const home = directories.make('ask-user-gate-qe-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  seedProjectWithJournal(config.dbPath);
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } }, arbiter: { schedule: () => () => {} } });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('QE — askUserGate in warn mode on update_working_state.questions_for_human', () => {
  it('accepts a free-text question of a manager, warns, journals one line authored daemon and counts it', async () => {
    const { manager } = await bootManager();

    const result = await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    expect(result.isError).toBeFalsy();
    expect(questionsForHumanOf(manager.id)).toEqual([FREE_TEXT_QUESTION]);
    expect(parsed(result).question_unclassified_warning).toContain('submit_plan_questions');
    const [line, ...otherLines] = journalLinesOfKind(JOURNAL_KIND);
    expect(otherLines).toEqual([]);
    expect(Object.values(line!)).toContain('daemon');
    expect(textOf(line!)).toContain(FREE_TEXT_QUESTION);
    expect(unclassifiedRows()).toEqual([expect.objectContaining({ session_id: manager.id, role: 'manager', outcome: 'observed', tool_name: 'update_working_state', command_excerpt: FREE_TEXT_QUESTION })]);
    expect(daemon.askUserGate.weeklyCountsOf(manager.id)).toMatchObject({ managerQuestions: 1, askUserQuestionAttempts: 0 });
  });

  it('writes one journal line per call however many new questions the call holds, and counts every question', async () => {
    const { manager } = await bootManager();

    await askHuman(manager.client, ['first free question?', 'second free question?', 'third free question?']);

    expect(journalLinesOfKind(JOURNAL_KIND)).toHaveLength(1);
    expect(unclassifiedRows()).toHaveLength(3);
    expect(daemon.askUserGate.weeklyCountsOf(manager.id).managerQuestions).toBe(3);
  });

  it('stays silent on a question the previous state already held', async () => {
    const { manager } = await bootManager();
    await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    const second = await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    expect(parsed(second).question_unclassified_warning).toBeUndefined();
    expect(journalLinesOfKind(JOURNAL_KIND)).toHaveLength(1);
    expect(unclassifiedRows()).toHaveLength(1);
  });

  it('stays silent on the [esc:] item the daemon wrote, even when the manager clears its list and writes the item again', async () => {
    const { manager, planNote } = await bootManager();
    await manager.client.callTool({ name: 'submit_plan_questions', arguments: { ticket: TICKET, plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'may we bump the contract_version?', class: 'contract' }] } });
    const [daemonItem] = questionsForHumanOf(manager.id);
    expect(daemonItem).toMatch(/^\[esc:/);
    await askHuman(manager.client, []);

    const result = await askHuman(manager.client, [daemonItem!]);

    expect(result.isError).toBeFalsy();
    expect(parsed(result).question_unclassified_warning).toBeUndefined();
    expect(journalLinesOfKind(JOURNAL_KIND)).toEqual([]);
    expect(unclassifiedRows()).toEqual([]);
  });

  it('warns on an [esc:] item forged by the manager: the escalation id must exist and belong to it', async () => {
    const { manager } = await bootManager();

    const result = await askHuman(manager.client, ['[esc:forged] Escalation on CCM-123: a human answer is needed']);

    expect(parsed(result).question_unclassified_warning).toContain('submit_plan_questions');
    expect(unclassifiedRows()).toHaveLength(1);
  });

  it('does not judge a session that is not a manager', async () => {
    const { rootClient } = await bootManager();

    const result = await askHuman(rootClient, [FREE_TEXT_QUESTION]);

    expect(result.isError).toBeFalsy();
    expect(parsed(result).question_unclassified_warning).toBeUndefined();
    expect(journalLinesOfKind(JOURNAL_KIND)).toEqual([]);
    expect(unclassifiedRows()).toEqual([]);
  });

  it('counts the AskUserQuestion attempts of the manager next to its free-text questions, per week, and states both in the journal line', async () => {
    const { manager } = await bootManager();
    await askUserQuestionByHook(manager.id);
    await vi.waitFor(() => expect(daemon.askUserGate.weeklyCountsOf(manager.id).askUserQuestionAttempts).toBe(1));

    await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    const counts = daemon.askUserGate.weeklyCountsOf(manager.id);
    expect(counts).toMatchObject({ managerQuestions: 1, askUserQuestionAttempts: 1 });
    expect(counts.week).toMatch(/^\d{4}-W\d{2}$/);
    const [line] = journalLinesOfKind(JOURNAL_KIND);
    expect(textOf(line!)).toContain(`week ${counts.week}: 1 manager question(s), 1 AskUserQuestion attempt(s)`);
  });

  it('leaves the entries of an earlier week out of the weekly count', async () => {
    const { manager } = await bootManager();
    daemon.db.prepare(`INSERT INTO denied_commands (id, session_id, manager_id, role, profile, harness, rule_id, decision_source, outcome, tool_name, command_excerpt, actor, created_at)
      VALUES (?, ?, ?, 'manager', 'manager', 'fake', 'question-unclassified', 'policy', 'observed', 'update_working_state', 'an old question', 'session', '2020-01-01T10:00:00.000Z')`).run(randomUUID(), manager.id, manager.id);

    await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    expect(daemon.askUserGate.weeklyCountsOf(manager.id).managerQuestions).toBe(1);
  });

  it('accepts the project setting enforce, stores it, and still behaves as warn with a warning that enforcement is a later slice', async () => {
    const { manager } = await bootManager();

    const stored = await setAskUserGate('enforce');
    const result = await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    expect(stored.status).toBe(200);
    const { escalation_policy_json } = daemon.db.prepare('SELECT escalation_policy_json FROM projects WHERE id = ?').get(PROJECT_ID) as { escalation_policy_json: string };
    expect(JSON.parse(escalation_policy_json).askUserGate).toBe('enforce');
    expect(result.isError).toBeFalsy();
    expect(questionsForHumanOf(manager.id)).toEqual([FREE_TEXT_QUESTION]);
    expect(parsed(result).question_unclassified_warning).toMatch(/enforce.*later slice/i);
    expect(journalLinesOfKind(JOURNAL_KIND)).toHaveLength(1);
    expect(unclassifiedRows()).toHaveLength(1);
  });

  it('does nothing when the project sets the gate to off', async () => {
    const { manager } = await bootManager();
    await setAskUserGate('off');

    const result = await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    expect(result.isError).toBeFalsy();
    expect(parsed(result).question_unclassified_warning).toBeUndefined();
    expect(journalLinesOfKind(JOURNAL_KIND)).toEqual([]);
    expect(unclassifiedRows()).toEqual([]);
  });

  it('still accepts the question when the manager has no journal bound, and counts it', async () => {
    const { manager } = await bootManager();
    daemon.db.prepare('UPDATE managers SET log_store_id = NULL WHERE session_id = ?').run(manager.id);

    const result = await askHuman(manager.client, [FREE_TEXT_QUESTION]);

    expect(result.isError).toBeFalsy();
    expect(questionsForHumanOf(manager.id)).toEqual([FREE_TEXT_QUESTION]);
    expect(daemon.askUserGate.weeklyCountsOf(manager.id).managerQuestions).toBe(1);
  });
});
