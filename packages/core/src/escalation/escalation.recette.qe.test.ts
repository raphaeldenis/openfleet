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
import { EscalationRepository } from './escalationRepository.js';

// The acceptance recipe of ESCALATION-LADDER01 on the real daemon: fake harness, the container startDaemon wires.
// REST answering (E5) is not in this stack: where the spec needs the human answer, the escalation is set answered
// through EscalationRepository, the way a human answer would land.

const PROJECT_ID = randomUUID();
const TICKET = 'CCM-123';
const CRITERIA_COLUMN = 'criteria_status';
const PENDING_OPTION_ID = 'pending-id';
const APPROVED_OPTION_ID = 'approved-id';
const WATCHING_PULSE_SECONDS = 3600;
const ARBITER_SPAWN_TIMEOUT_MS = 5000;
const HUMAN_ITEM_PREFIX = '[esc:';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;
interface Seed { backlogId: string; rowId: string; criteriaColumnId: string }
interface SessionRow { id: string }

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
  const client = new Client({ name: 'escalation-recette', version: '1' });
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
  const manager = await spawn(rootClient, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: WATCHING_PULSE_SECONDS } });
  await manager.client.callTool({ name: 'get_manager_base', arguments: {} });
  await manager.client.callTool({ name: 'bootstrap_project_profile', arguments: {} });
  const planNote = await aNote('Plan');
  return { manager, planNote };
}

const technical = (id: string) => ({ id, text: `how to name the helper ${id}`, class: 'technical' });
const FIVE_TECHNICAL_IDS = ['q1', 'q2', 'q3', 'q4', 'q5'];
const fiveTechnical = FIVE_TECHNICAL_IDS.map(technical);
const contractQuestion = { id: 'q6', text: 'may we bump the contract_version?', class: 'contract' };
const submit = (client: Client, input: Json) => client.callTool({ name: 'submit_plan_questions', arguments: { ticket: TICKET, ...input } });
const approve = (client: Client, planNoteId: string) => client.callTool({ name: 'approve_plan_criteria', arguments: { ticket: TICKET, plan_note_id: planNoteId } });

const decided = (questionId: string) => ({ question_id: questionId, verdict: 'decided', decision: `use the plain name for ${questionId}`, rationale: `it reads best, ${questionId}` });
const opinion = (batchId: string, decisions: unknown[], criteria: Json) => ({ batch_id: batchId, decisions, criteria });
const FAVOURABLE = { opinion: 'favourable', reasons: [] };
const NOT_ASKED = { opinion: 'not_asked', reasons: [] };
const report = (client: Client, input: Json) => client.callTool({ name: 'report_arbiter_opinion', arguments: input });
const toolNamesOf = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort();

const arbiterRows = (): SessionRow[] => daemon.db.prepare("SELECT id FROM sessions WHERE role = 'arbiter' ORDER BY created_at, rowid").all() as unknown as SessionRow[];
const waitForArbiters = async (count: number): Promise<SessionRow[]> => {
  await vi.waitFor(() => expect(arbiterRows()).toHaveLength(count), { timeout: ARBITER_SPAWN_TIMEOUT_MS });
  return arbiterRows();
};
const closeSession = (sessionId: string) => adminApi(`/api/sessions/${sessionId}/close`, { method: 'POST', body: '{}' });

interface QuestionRow { question_id: string; route: string; status: string; reason: string | null; escalation_id: string | null }
const questionRows = (): QuestionRow[] => daemon.db.prepare('SELECT * FROM plan_questions ORDER BY rowid').all() as unknown as QuestionRow[];
const questionOf = (questionId: string) => questionRows().find((row) => row.question_id === questionId)!;
const escalationRows = () => daemon.db.prepare('SELECT * FROM escalations').all() as { id: string; status: string; body: string }[];
const decisionRows = () => daemon.db.prepare('SELECT question_id, verdict, arbiter_session_id FROM arbiter_decisions ORDER BY id').all() as { question_id: string; verdict: string; arbiter_session_id: string }[];
const noteBody = (noteId: string) => (daemon.db.prepare('SELECT body_md FROM notes WHERE id = ?').get(noteId) as { body_md: string }).body_md;
const missionNoteBodyOf = (managerId: string) => {
  const { mission_note_id } = daemon.db.prepare('SELECT mission_note_id FROM managers WHERE session_id = ?').get(managerId) as { mission_note_id: string };
  return noteBody(mission_note_id);
};
const humanItemsOf = (managerId: string): string[] => {
  const row = daemon.db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(managerId) as { sections_json: string } | undefined;
  const questionsForHuman = row ? (JSON.parse(row.sections_json) as { questionsForHuman: string[] }).questionsForHuman : [];
  return questionsForHuman.filter((item) => item.startsWith(HUMAN_ITEM_PREFIX));
};
const arbiterMessagesTo = (managerId: string) => (daemon.db.prepare("SELECT body FROM message_queue WHERE session_id = ? AND body LIKE '%[arbiter]%' ORDER BY created_at, rowid").all(managerId) as { body: string }[]).map(({ body }) => body);

const journalRows = (): Json[] => (daemon.db.prepare('SELECT data_json FROM ds_rows WHERE store_id <> ? ORDER BY rowid').all(seed.backlogId) as { data_json: string }[]).map(({ data_json }) => JSON.parse(data_json) as Json);
const journalRowsOf = (author: string, text: string): Json[] => journalRows()
  .filter((cells) => Object.values(cells).includes(author) && Object.values(cells).some((value) => typeof value === 'string' && value.includes(text)));
const backlogCriteriaCell = (): unknown => {
  const { data_json } = daemon.db.prepare('SELECT data_json FROM ds_rows WHERE id = ?').get(seed.rowId) as { data_json: string };
  return (JSON.parse(data_json) as Json)[seed.criteriaColumnId];
};

/** Stands in for the REST answer of E5: closes the escalation and answers its questions through the repository. */
const humanAnswersEveryEscalation = () => {
  const repository = new EscalationRepository(daemon.db);
  const answeredAt = new Date().toISOString();
  for (const escalation of escalationRows().filter(({ status }) => status === 'pending')) {
    for (const { batchId, questionId } of repository.questionsOfEscalation(escalation.id)) {
      repository.transitionQuestion({ batchId, questionId, from: 'pending_human', to: 'answered', humanAnswer: 'yes, bump it', answeredAt });
    }
    repository.answerEscalationIfPending({ id: escalation.id, resolvedAt: answeredAt });
  }
};

function seedBacklogAndJournal(dbPath: string): Seed {
  const db = openDatabase(dbPath);
  new ProjectRepository(db).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  const scope = { projectId: PROJECT_ID };
  const stores = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => new Date().toISOString(), newId: randomUUID });
  const backlog = stores.createStore({ ...scope, displayName: 'Manager backlog' });
  const ticketColumn = stores.addColumn(backlog.id, { ...scope, displayName: 'Ticket', columnType: 'text' });
  stores.setNaturalKey(backlog.id, { ...scope, columnId: ticketColumn.id });
  const criteriaColumn = stores.addColumn(backlog.id, { ...scope, displayName: CRITERIA_COLUMN, columnType: 'select', options: [{ id: PENDING_OPTION_ID, label: 'pending' }, { id: APPROVED_OPTION_ID, label: 'approved' }] });
  const journal = stores.createStore({ ...scope, displayName: 'Manager journal' });
  stores.addColumn(journal.id, { ...scope, displayName: 'Entry', columnType: 'text' });
  stores.addColumn(journal.id, { ...scope, displayName: 'Author', columnType: 'text' });
  const row = stores.insertRow(backlog.id, { ...scope, actor: { kind: 'human', label: 'You' }, data: { [ticketColumn.id]: TICKET, [criteriaColumn.id]: PENDING_OPTION_ID } });
  db.close();
  return { backlogId: backlog.id, rowId: row.id, criteriaColumnId: criteriaColumn.id };
}

beforeEach(async () => {
  clients = [];
  const home = directories.make('escalation-recette-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  seed = seedBacklogAndJournal(config.dbPath);
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } }, arbiter: { schedule: () => () => {} } });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('Recette — the escalation ladder on the real daemon', () => {
  it('A1: five technical questions and one contract question make exactly ONE human escalation; the arbiter decides the five others and the daemon journals them', async () => {
    const { manager, planNote } = await bootManager();

    const answer = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [...fiveTechnical, contractQuestion] }));

    expect(answer.arbiter).toEqual({ status: 'pending', question_ids: FIVE_TECHNICAL_IDS });
    expect(answer.human).toEqual({ escalation_id: expect.any(String), question_ids: ['q6'] });
    expect(escalationRows()).toHaveLength(1);
    expect(escalationRows()[0]).toMatchObject({ id: answer.human.escalation_id, status: 'pending' });
    expect(humanItemsOf(manager.id)).toEqual([expect.stringContaining(answer.human.escalation_id)]);
    expect(FIVE_TECHNICAL_IDS.map((id) => questionOf(id).route)).toEqual(FIVE_TECHNICAL_IDS.map(() => 'arbiter'));
    expect(questionOf('q6')).toMatchObject({ route: 'human', status: 'pending_human' });

    const [arbiter] = await waitForArbiters(1);
    await report(await connect(arbiter!.id), opinion(answer.batch_id, FIVE_TECHNICAL_IDS.map(decided), NOT_ASKED));

    expect(FIVE_TECHNICAL_IDS.map((id) => questionOf(id).status)).toEqual(FIVE_TECHNICAL_IDS.map(() => 'decided'));
    expect(journalRowsOf('arbiter', TICKET)).toHaveLength(FIVE_TECHNICAL_IDS.length);
    expect(escalationRows()).toHaveLength(1);
    expect(humanItemsOf(manager.id)).toHaveLength(1);
  });

  it('A2: the five decisions leave five rows, five sections in the plan note, one [arbiter] message and a mission note untouched, with still ONE human question', async () => {
    const { manager, planNote } = await bootManager();
    const missionBefore = missionNoteBodyOf(manager.id);
    const answer = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [...fiveTechnical, contractQuestion] }));
    const [arbiter] = await waitForArbiters(1);

    const result = await report(await connect(arbiter!.id), opinion(answer.batch_id, FIVE_TECHNICAL_IDS.map(decided), NOT_ASKED));

    expect(result.isError).toBeFalsy();
    expect(decisionRows()).toEqual(FIVE_TECHNICAL_IDS.map((id) => ({ question_id: id, verdict: 'decided', arbiter_session_id: arbiter!.id })));
    const planBody = noteBody(planNote.id);
    for (const id of FIVE_TECHNICAL_IDS) expect(planBody).toContain(`## Arbiter decision ${answer.batch_id} ${id}`);
    const [message, ...otherMessages] = arbiterMessagesTo(manager.id);
    expect(otherMessages).toEqual([]);
    expect(message).toContain('[arbiter] decided q1,q2,q3,q4,q5 on CCM-123');
    expect(missionNoteBodyOf(manager.id)).toBe(missionBefore);
    expect(escalationRows()).toHaveLength(1);
    expect(humanItemsOf(manager.id)).toHaveLength(1);
  });

  it('A3: approve_plan_criteria is refused with escalation_open while the human has not answered, and the backlog stays pending', async () => {
    const { manager, planNote } = await bootManager();
    const answer = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [...fiveTechnical, contractQuestion] }));
    const [arbiter] = await waitForArbiters(1);
    await report(await connect(arbiter!.id), opinion(answer.batch_id, FIVE_TECHNICAL_IDS.map(decided), NOT_ASKED));

    const result = await approve(manager.client, planNote.id);

    expect(rawText(result)).toMatch(/^error escalation_open: /);
    expect(backlogCriteriaCell()).toBe(PENDING_OPTION_ID);
  });

  it('A4: after the human answer and a favourable opinion on the current revision, the daemon sets criteria_status and journals "criteria approved" with the author arbiter', async () => {
    const { manager, planNote } = await bootManager();
    const first = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [...fiveTechnical, contractQuestion] }));
    const [firstArbiter] = await waitForArbiters(1);
    await report(await connect(firstArbiter!.id), opinion(first.batch_id, FIVE_TECHNICAL_IDS.map(decided), NOT_ASKED));
    humanAnswersEveryEscalation();
    const followUp = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q7')] }));
    const [, secondArbiter] = await waitForArbiters(2);
    await report(await connect(secondArbiter!.id), opinion(followUp.batch_id, [decided('q7')], FAVOURABLE));

    const result = await approve(manager.client, planNote.id);

    expect(result.isError).toBeFalsy();
    expect(parsed(result)).toEqual({ approved: true, opinion_id: followUp.batch_id });
    expect(backlogCriteriaCell()).toBe(APPROVED_OPTION_ID);
    expect(journalRowsOf('arbiter', 'criteria approved')).toHaveLength(1);
  });

  it('A11: an arbiter that closes twice leaves the technical questions in the single human escalation with arbiter_unavailable, and the manager decides nothing', async () => {
    const { manager, planNote } = await bootManager();
    await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1'), technical('q2'), contractQuestion] });
    const [first] = await waitForArbiters(1);

    await closeSession(first!.id);
    const [, second] = await waitForArbiters(2);
    await closeSession(second!.id);

    await vi.waitFor(() => expect(questionOf('q1').status).toBe('pending_human'), { timeout: ARBITER_SPAWN_TIMEOUT_MS });
    expect(questionOf('q1')).toMatchObject({ reason: 'arbiter_unavailable' });
    expect(questionOf('q2')).toMatchObject({ status: 'pending_human', reason: 'arbiter_unavailable' });
    expect(escalationRows()).toHaveLength(1);
    expect(humanItemsOf(manager.id)).toHaveLength(1);
    expect(decisionRows()).toEqual([]);
    expect(arbiterRows()).toHaveLength(2);
  });

  it('A21: the escalation service is the one startDaemon wires: a manager reaches it through the MCP tools of the booted daemon, no service built by hand', async () => {
    const { manager, planNote } = await bootManager();

    const answer = await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1')] });
    const approval = await approve(manager.client, planNote.id);

    expect(answer.isError).toBeFalsy();
    expect(parsed(answer).batch_id).toEqual(expect.any(String));
    expect(rawText(approval)).toMatch(/^error criteria_stale: /);
    expect(approval.isError).toBe(true);
  });

  it('A22: tools/list gives a manager submit_plan_questions and approve_plan_criteria, and an arbiter exactly report_arbiter_opinion and message_parent', async () => {
    const { manager, planNote } = await bootManager();
    await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1')] });
    const [arbiter] = await waitForArbiters(1);

    const managerTools = await toolNamesOf(manager.client);
    const arbiterTools = await toolNamesOf(await connect(arbiter!.id));

    expect(managerTools).toEqual(expect.arrayContaining(['submit_plan_questions', 'approve_plan_criteria', 'report_arbiter_opinion']));
    expect(arbiterTools).toEqual(['message_parent', 'report_arbiter_opinion']);
  });
});
