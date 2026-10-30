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
const CRITERIA_COLUMN = 'criteria_status';
const PENDING_LABEL = 'pending';
const APPROVED_LABEL = 'approved';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;
interface Seed { backlogId: string; rowId: string; criteriaColumnId: string; approvedOptionId: string; pendingOptionId: string }

let daemon: Daemon;
let adminToken: string;
let worktreesRoot: string;
let seed: Seed;
let clients: Client[];
const directories = createTempDirTracker();

const rawText = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));
const tokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;

const adminApi = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...options.headers },
});

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'criteria-qe', version: '1' });
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

const editNote = async (noteId: string) => {
  const { rev } = daemon.db.prepare('SELECT rev FROM notes WHERE id = ?').get(noteId) as { rev: number };
  await adminApi(`/api/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ projectId: PROJECT_ID, expectedRev: rev, bodyMd: '# Plan\n\n## Plan\n\nthe plan, edited after the opinion' }) });
};

async function bootManager() {
  const root = await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: worktreesRoot, name: 'Root', harness: 'fake', emoji: '🤖', projectId: PROJECT_ID }) });
  const rootClient = await connect(((await root.json()) as { id: string }).id);
  const manager = await spawn(rootClient, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 } });
  await manager.client.callTool({ name: 'get_manager_base', arguments: {} });
  await manager.client.callTool({ name: 'bootstrap_project_profile', arguments: {} });
  const planNote = await aNote('Plan');
  return { manager, planNote };
}

const technical = (id: string) => ({ id, text: `how to name the helper ${id}`, class: 'technical' });
const contractQuestion = { id: 'q6', text: 'may we bump the contract_version?', class: 'contract' };
const submit = (client: Client, input: Json) => client.callTool({ name: 'submit_plan_questions', arguments: { ticket: TICKET, ...input } });
const approve = (client: Client, planNoteId: string, ticket = TICKET) => client.callTool({ name: 'approve_plan_criteria', arguments: { ticket, plan_note_id: planNoteId } });

const decided = (questionId: string) => ({ question_id: questionId, verdict: 'decided', decision: `use the plain name for ${questionId}`, rationale: `it reads best, ${questionId}` });
const opinion = (batchId: string, decisions: unknown[], criteria: Json) => ({ batch_id: batchId, decisions, criteria });
const FAVOURABLE = { opinion: 'favourable', reasons: [] };
const NOT_ASKED = { opinion: 'not_asked', reasons: [] };
const report = (client: Client, input: Json) => client.callTool({ name: 'report_arbiter_opinion', arguments: input });

interface SessionRow { id: string }
const arbiterRows = (): SessionRow[] => daemon.db.prepare("SELECT id FROM sessions WHERE role = 'arbiter' ORDER BY created_at, rowid").all() as unknown as SessionRow[];
const waitForArbiters = async (count: number): Promise<SessionRow[]> => {
  await vi.waitFor(() => expect(arbiterRows()).toHaveLength(count), { timeout: 5000 });
  return arbiterRows();
};

/** Submits a batch, lets its arbiter report, and answers the batch id. */
async function arbitratedBatch({ manager, planNoteId, questions, arbiterNumber, criteria }: {
  manager: { client: Client }; planNoteId: string; questions: Json[]; arbiterNumber: number; criteria: Json;
}): Promise<string> {
  const answer = parsed(await submit(manager.client, { plan_note_id: planNoteId, questions }));
  const arbiter = (await waitForArbiters(arbiterNumber))[arbiterNumber - 1]!;
  const arbitratedIds = questions.filter(({ class: questionClass }) => questionClass === 'technical').map(({ id }) => id as string);
  await report(await connect(arbiter.id), opinion(answer.batch_id, arbitratedIds.map(decided), criteria));
  return answer.batch_id;
}

const humanAnswersEveryEscalation = () => {
  daemon.db.prepare("UPDATE plan_questions SET status = 'answered' WHERE status = 'pending_human'").run();
  daemon.db.prepare("UPDATE escalations SET status = 'answered', resolved_at = 't9' WHERE status = 'pending'").run();
};

const backlogCriteriaCell = (): unknown => {
  const { data_json } = daemon.db.prepare('SELECT data_json FROM ds_rows WHERE id = ?').get(seed.rowId) as { data_json: string };
  return (JSON.parse(data_json) as Json)[seed.criteriaColumnId];
};
const backlogHistory = () => daemon.db.prepare('SELECT actor_kind, actor_label FROM ds_row_history WHERE row_id = ? ORDER BY rowid').all(seed.rowId) as { actor_kind: string; actor_label: string }[];
const journalRowsMentioning = (text: string): Json[] => (daemon.db.prepare('SELECT data_json FROM ds_rows WHERE store_id <> ? ORDER BY rowid').all(seed.backlogId) as { data_json: string }[])
  .map(({ data_json }) => JSON.parse(data_json) as Json)
  .filter((cells) => Object.values(cells).some((value) => typeof value === 'string' && value.includes(text)));

function seedBacklog(dbPath: string, { withCriteriaColumn = true } = {}): Seed {
  const db = openDatabase(dbPath);
  new ProjectRepository(db).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  const scope = { projectId: PROJECT_ID };
  const stores = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => new Date().toISOString(), newId: randomUUID });
  const backlog = stores.createStore({ ...scope, displayName: 'Manager backlog' });
  const ticketColumn = stores.addColumn(backlog.id, { ...scope, displayName: 'Ticket', columnType: 'text' });
  stores.setNaturalKey(backlog.id, { ...scope, columnId: ticketColumn.id });
  const criteriaColumn = withCriteriaColumn
    ? stores.addColumn(backlog.id, { ...scope, displayName: CRITERIA_COLUMN, columnType: 'select', options: [{ id: 'pending-id', label: PENDING_LABEL }, { id: 'approved-id', label: APPROVED_LABEL }] })
    : undefined;
  const journal = stores.createStore({ ...scope, displayName: 'Manager journal' });
  stores.addColumn(journal.id, { ...scope, displayName: 'Entry', columnType: 'text' });
  stores.addColumn(journal.id, { ...scope, displayName: 'Author', columnType: 'text' });
  const row = stores.insertRow(backlog.id, { ...scope, actor: { kind: 'human', label: 'You' }, data: { [ticketColumn.id]: TICKET, ...(criteriaColumn && { [criteriaColumn.id]: 'pending-id' }) } });
  db.close();
  return { backlogId: backlog.id, rowId: row.id, criteriaColumnId: criteriaColumn?.id ?? '', approvedOptionId: 'approved-id', pendingOptionId: 'pending-id' };
}

async function bootDaemonWithBacklog(options: { withCriteriaColumn?: boolean } = {}) {
  const home = directories.make('criteria-qe-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  seed = seedBacklog(config.dbPath, options);
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } }, arbiter: { schedule: () => () => {} } });
}

beforeEach(async () => {
  clients = [];
  await bootDaemonWithBacklog();
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('QE — approve_plan_criteria', () => {
  it('A3: refuses with escalation_open while the human question of the ticket is unanswered, and leaves the backlog alone', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1'), contractQuestion], arbiterNumber: 1, criteria: NOT_ASKED });

    const result = await approve(manager.client, planNote.id);

    expect(rawText(result)).toMatch(/^error escalation_open: /);
    expect(backlogCriteriaCell()).toBe(seed.pendingOptionId);
  });

  it('A4: once the human answered and the arbiter is favourable on the current revision, the daemon sets the column and journals "criteria approved" with the author arbiter', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1'), contractQuestion], arbiterNumber: 1, criteria: NOT_ASKED });
    humanAnswersEveryEscalation();
    const batchId = await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q7')], arbiterNumber: 2, criteria: FAVOURABLE });

    const result = await approve(manager.client, planNote.id);

    expect(result.isError).toBeFalsy();
    expect(parsed(result)).toEqual({ approved: true, opinion_id: batchId });
    expect(backlogCriteriaCell()).toBe(seed.approvedOptionId);
    expect(backlogHistory().at(-1)).toEqual({ actor_kind: 'agent', actor_label: 'arbiter' });
    const [approvalLine, ...otherApprovalLines] = journalRowsMentioning('criteria approved');
    expect(otherApprovalLines).toEqual([]);
    expect(Object.values(approvalLine!)).toContain('arbiter');
    expect(Object.values(approvalLine!).join(' ')).toContain(TICKET);
  });

  it('the stale-note case: a plan note edited after the favourable opinion is criteria_stale and the backlog is untouched', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1')], arbiterNumber: 1, criteria: FAVOURABLE });
    await editNote(planNote.id);

    const result = await approve(manager.client, planNote.id);

    expect(rawText(result)).toMatch(/^error criteria_stale: /);
    expect(backlogCriteriaCell()).toBe(seed.pendingOptionId);
    expect(journalRowsMentioning('criteria approved')).toEqual([]);
  });

  it('refuses with criteria_stale a manager whose arbiter was not favourable', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1')], arbiterNumber: 1, criteria: { opinion: 'unfavourable', reasons: ['the acceptance criteria miss a failure case'] } });

    const result = await approve(manager.client, planNote.id);

    expect(rawText(result)).toMatch(/^error criteria_stale: .*favourable/);
    expect(backlogCriteriaCell()).toBe(seed.pendingOptionId);
  });

  it('refuses with criteria_stale while a later batch of the ticket still waits for its arbiter, even after an older favourable opinion', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1')], arbiterNumber: 1, criteria: FAVOURABLE });
    await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q2')] });

    const result = await approve(manager.client, planNote.id);

    expect(rawText(result)).toMatch(/^error criteria_stale: .*arbiter/);
    expect(backlogCriteriaCell()).toBe(seed.pendingOptionId);
  });

  it('answers escalation_not_found for a ticket the manager never submitted questions on', async () => {
    const { manager, planNote } = await bootManager();

    const result = await approve(manager.client, planNote.id, 'CCM-999');

    expect(rawText(result)).toMatch(/^error escalation_not_found: /);
    expect(backlogCriteriaCell()).toBe(seed.pendingOptionId);
  });

  it('a second approval of the same revision answers approved again, writes nothing more and journals once', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1')], arbiterNumber: 1, criteria: FAVOURABLE });
    await approve(manager.client, planNote.id);
    const historyAfterFirst = backlogHistory().length;

    const second = await approve(manager.client, planNote.id);

    expect(second.isError).toBeFalsy();
    expect(parsed(second)).toMatchObject({ approved: true });
    expect(backlogHistory()).toHaveLength(historyAfterFirst);
    expect(journalRowsMentioning('criteria approved')).toHaveLength(1);
  });

  it('refuses a caller that is not a manager with not_a_manager', async () => {
    const { manager, planNote } = await bootManager();
    const child = await spawn(manager.client);

    const result = await approve(child.client, planNote.id);

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
  });

  it('refuses the mission note as plan note with invalid_body', async () => {
    const { manager } = await bootManager();
    const { mission_note_id } = daemon.db.prepare('SELECT mission_note_id FROM managers WHERE session_id = ?').get(manager.id) as { mission_note_id: string };

    const result = await approve(manager.client, mission_note_id);

    expect(rawText(result)).toMatch(/^error invalid_body: .*mission note/);
  });

  it('is not offered to the arbiter', async () => {
    const { manager, planNote } = await bootManager();
    await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1')] });
    const [arbiter] = await waitForArbiters(1);

    const arbiterTools = (await (await connect(arbiter!.id)).listTools()).tools.map((tool) => tool.name);

    expect(arbiterTools).not.toContain('approve_plan_criteria');
  });
});

describe('QE — F9B: the row guard on the criteria_status column warns and allows (warn mode)', () => {
  const setCriteriaByRest = (optionId: string) => adminApi(`/api/data-stores/${seed.backlogId}/rows`, {
    method: 'PATCH', body: JSON.stringify({ projectId: PROJECT_ID, updates: [{ rowId: seed.rowId, patch: { [seed.criteriaColumnId]: optionId } }] }),
  });

  it('allows a caller other than the daemon to set approved, journals a warning and counts it', async () => {
    await bootManager();

    const response = await setCriteriaByRest(seed.approvedOptionId);

    expect(response.status).toBe(200);
    expect(backlogCriteriaCell()).toBe(seed.approvedOptionId);
    expect(daemon.criteriaStatusGuard.warningCount()).toBe(1);
    const [warningLine, ...otherLines] = journalRowsMentioning('criteria_status');
    expect(otherLines).toEqual([]);
    expect(Object.values(warningLine!)).toContain('daemon');
    expect(Object.values(warningLine!).join(' ')).toContain('You');
  });

  it('warns on a row inserted already approved by a caller other than the daemon', async () => {
    await bootManager();

    const response = await adminApi(`/api/data-stores/${seed.backlogId}/rows`, {
      method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, rows: [{ [seed.criteriaColumnId]: seed.approvedOptionId }] }),
    });

    expect(response.status).toBe(201);
    expect(daemon.criteriaStatusGuard.warningCount()).toBe(1);
  });

  it('stays silent for a write that does not set approved', async () => {
    await bootManager();

    await setCriteriaByRest(seed.pendingOptionId);

    expect(daemon.criteriaStatusGuard.warningCount()).toBe(0);
    expect(journalRowsMentioning('criteria_status')).toEqual([]);
  });

  it('stays silent when the daemon itself approves the criteria', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1')], arbiterNumber: 1, criteria: FAVOURABLE });

    await approve(manager.client, planNote.id);

    expect(backlogCriteriaCell()).toBe(seed.approvedOptionId);
    expect(daemon.criteriaStatusGuard.warningCount()).toBe(0);
    expect(journalRowsMentioning('criteria_status')).toEqual([]);
  });
});

describe('QE — approve_plan_criteria on a backlog the daemon cannot write', () => {
  beforeEach(async () => {
    for (const client of clients) await client.close();
    clients = [];
    await daemon.close();
    daemon.db.close();
    directories.removeAll();
    await bootDaemonWithBacklog({ withCriteriaColumn: false });
  });

  it('says which column to add with invalid_body when the backlog has no criteria_status column', async () => {
    const { manager, planNote } = await bootManager();
    await arbitratedBatch({ manager, planNoteId: planNote.id, questions: [technical('q1')], arbiterNumber: 1, criteria: FAVOURABLE });

    const result = await approve(manager.client, planNote.id);

    expect(rawText(result)).toMatch(/^error invalid_body: .*criteria_status/);
    expect(journalRowsMentioning('criteria approved')).toEqual([]);
  });
});
