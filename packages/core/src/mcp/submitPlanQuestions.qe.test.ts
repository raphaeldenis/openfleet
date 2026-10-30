import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EscalationPolicySchema } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const TICKET = 'CCM-123';
const ESCALATION_ITEM_PREFIX = '[esc:';

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

const adminApi = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...options.headers },
});

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'escalation-qe', version: '1' });
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
  const planNote = await aNote('Plan');
  return { manager, planNote };
}

const technical = (id: string, text = `how to name the helper ${id}`) => ({ id, text, class: 'technical' });
const submit = (client: Client, input: Json) => client.callTool({ name: 'submit_plan_questions', arguments: { ticket: TICKET, ...input } });

interface QuestionRow { question_id: string; declared_class: string; computed_classes_json: string; effective_classes_json: string; route: string; status: string; reason: string | null; batch_id: string; escalation_id: string | null }
const questionRows = (): QuestionRow[] => daemon.db.prepare('SELECT * FROM plan_questions ORDER BY rowid').all() as unknown as QuestionRow[];
const escalationRows = () => daemon.db.prepare('SELECT * FROM escalations').all() as { id: string; manager_id: string; ticket: string; status: string; body: string }[];
const decisionCount = () => (daemon.db.prepare('SELECT COUNT(*) AS count FROM arbiter_decisions').get() as { count: number }).count;
const questionsForHumanOf = (managerId: string): string[] => {
  const row = daemon.db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(managerId) as { sections_json: string } | undefined;
  return row ? (JSON.parse(row.sections_json) as { questionsForHuman: string[] }).questionsForHuman : [];
};
const escalationItemsOf = (managerId: string) => questionsForHumanOf(managerId).filter((item) => item.startsWith(ESCALATION_ITEM_PREFIX));

beforeEach(async () => {
  clients = [];
  const home = directories.make('escalation-qe-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('QE — submit_plan_questions on a booted daemon', () => {
  it('A1: five technical questions and one contract question make one human escalation, one [esc:] item and five questions waiting for the arbiter', async () => {
    const { manager, planNote } = await bootManager();
    const questions = [...['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => technical(id)), { id: 'q6', text: 'may we bump the contract_version?', class: 'contract' }];

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions });

    expect(result.isError).toBeFalsy();
    const answer = parsed(result);
    const [escalation] = escalationRows();
    expect(escalationRows()).toHaveLength(1);
    expect(answer).toEqual({
      batch_id: expect.any(String), self: [],
      arbiter: { status: 'pending', question_ids: ['q1', 'q2', 'q3', 'q4', 'q5'] },
      human: { escalation_id: escalation!.id, question_ids: ['q6'] },
    });
    expect(escalationItemsOf(manager.id)).toEqual([expect.stringContaining(`${ESCALATION_ITEM_PREFIX}${escalation!.id}]`)]);
    expect(questionRows().map(({ question_id, route, status }) => [question_id, route, status])).toEqual([
      ['q1', 'arbiter', 'open'], ['q2', 'arbiter', 'open'], ['q3', 'arbiter', 'open'], ['q4', 'arbiter', 'open'], ['q5', 'arbiter', 'open'], ['q6', 'human', 'pending_human'],
    ]);
  });

  it('keeps the five technical questions open without any decision while no arbiter exists: nothing is decided by the daemon or by the manager, and the human list stays the single escalation (fail closed, F6A)', async () => {
    const { manager, planNote } = await bootManager();

    await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1'), technical('q2'), { id: 'q3', text: 'the contract_version moves', class: 'technical' }] });

    expect(decisionCount()).toBe(0);
    expect(questionRows().filter(({ status }) => status === 'decided')).toEqual([]);
    expect(escalationRows()).toHaveLength(1);
  });

  it('writes the body of the escalation itself: ticket, count, classes, the question, its options and the recommendation of the manager, secrets masked', async () => {
    const { manager, planNote } = await bootManager();
    const fakeToken = ['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789';

    await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: `rotate the credential ${fakeToken}?`, class: 'security', options: ['now', 'later'], recommendation: 'now' }] });

    const [escalation] = escalationRows();
    expect(escalation!.body).toContain(`on ${TICKET}: 1 question(s) — security`);
    expect(escalation!.body).toContain('rotate the credential');
    expect(escalation!.body).toContain('now');
    expect(escalation!.body).not.toContain(fakeToken);
    expect(escalation!.body.length).toBeLessThanOrEqual(2000);
  });

  it('A5: a question labelled technical that cites contract_version goes to the human; the table keeps declared technical and computed contract', async () => {
    const { manager, planNote } = await bootManager();

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'raise contract_version for this?', class: 'technical' }, { id: 'q2', text: 'where does the helper live', class: 'technical', paths: ['packages/core/src/mcp/contract.pinned.json'] }] });

    expect(parsed(result).human.question_ids).toEqual(['q1', 'q2']);
    expect(questionRows().map(({ declared_class, computed_classes_json, effective_classes_json, route }) => ({ declared_class, computed: JSON.parse(computed_classes_json), effective: JSON.parse(effective_classes_json), route })))
      .toEqual([{ declared_class: 'technical', computed: ['contract'], effective: ['contract'], route: 'human' }, { declared_class: 'technical', computed: ['contract'], effective: ['contract'], route: 'human' }]);
  });

  it('A6: a class outside the vocabulary is not refused: the question goes to the human as unknown', async () => {
    const { manager, planNote } = await bootManager();

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'tabs or spaces', class: 'banana' }] });

    expect(result.isError).toBeFalsy();
    expect(questionRows().map(({ declared_class, route, reason }) => ({ declared_class, route, reason }))).toEqual([{ declared_class: 'banana', route: 'human', reason: 'unclassified' }]);
  });

  it('A7 and A8: a factual question proven by a run resolves itself; one without an executed proof goes to the arbiter, never to the human', async () => {
    const { manager, planNote } = await bootManager();
    const proof = { claim: 'the repository exists', status: 'proven', command: 'git ls-remote origin', output: 'abc123 HEAD' };

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'does the repository exist', class: 'factual', resolution: proof }, { id: 'q2', text: 'is the port free', class: 'factual' }] });

    expect(parsed(result)).toMatchObject({ self: [{ question_id: 'q1' }], arbiter: { question_ids: ['q2'] }, human: null });
    expect(questionRows().map(({ question_id, route, status }) => [question_id, route, status])).toEqual([['q1', 'self', 'self_resolved'], ['q2', 'arbiter', 'open']]);
    expect(escalationRows()).toEqual([]);
    expect(escalationItemsOf(manager.id)).toEqual([]);
  });

  it('merges a later escalating batch of the same ticket into the open escalation: one escalation, one item, the same item text, a rebuilt body', async () => {
    const { manager, planNote } = await bootManager();
    await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'bump the contract_version', class: 'contract' }] });
    const itemBefore = escalationItemsOf(manager.id);

    const second = await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q9', text: 'may we waive the criterion', class: 'dod_waiver' }] });

    const [escalation] = escalationRows();
    expect(escalationRows()).toHaveLength(1);
    expect(parsed(second).human).toEqual({ escalation_id: escalation!.id, question_ids: ['q9'] });
    expect(escalationItemsOf(manager.id)).toEqual(itemBefore);
    expect(escalation!.body).toContain('2 question(s) — contract, dod_waiver');
    expect(questionRows().map(({ escalation_id }) => escalation_id)).toEqual([escalation!.id, escalation!.id]);
  });

  it('opens a separate escalation for another ticket', async () => {
    const { manager, planNote } = await bootManager();
    await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'bump the contract_version', class: 'contract' }] });

    await manager.client.callTool({ name: 'submit_plan_questions', arguments: { ticket: 'CCM-456', plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'bump the contract_version', class: 'contract' }] } });

    expect(escalationRows().map(({ ticket }) => ticket).sort()).toEqual([TICKET, 'CCM-456']);
    expect(escalationItemsOf(manager.id)).toHaveLength(2);
  });

  it('A15: a class the project took off its human list goes to the arbiter with the reason class_disabled_by_project', async () => {
    const { manager, planNote } = await bootManager();
    new ProjectRepository(daemon.db).update(PROJECT_ID, { escalation: EscalationPolicySchema.parse({ humanClasses: ['contract', 'security', 'deployment', 'history_rewrite', 'dod_waiver', 'visual_qa'] }) });

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions: [{ id: 'q1', text: 'raise the budget', class: 'spend' }] });

    expect(parsed(result)).toMatchObject({ arbiter: { question_ids: ['q1'] }, human: null });
    expect(questionRows().map(({ route, reason }) => ({ route, reason }))).toEqual([{ route: 'arbiter', reason: 'class_disabled_by_project' }]);
  });

  it('refuses a session that is not a manager with not_a_manager and writes nothing', async () => {
    const { manager, planNote } = await bootManager();
    const child = await spawn(manager.client);

    const result = await submit(child.client, { plan_note_id: planNote.id, questions: [technical('q1')] });

    expect(result.isError).toBe(true);
    expect(rawText(result)).toMatch(/^error not_a_manager: /);
    expect(questionRows()).toEqual([]);
  });

  it('A17: refuses the mission note as plan note with invalid_body and leaves the note untouched', async () => {
    const { manager, planNote } = await bootManager();
    await adminApi(`/api/managers/${manager.id}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId: planNote.id }) });
    const noteBefore = daemon.db.prepare('SELECT body_md, rev FROM notes WHERE id = ?').get(planNote.id);

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1')] });

    expect(rawText(result)).toMatch(/^error invalid_body: .*mission note/);
    expect(daemon.db.prepare('SELECT body_md, rev FROM notes WHERE id = ?').get(planNote.id)).toEqual(noteBefore);
    expect(questionRows()).toEqual([]);
  });

  it('refuses a plan note that does not exist with note_not_found', async () => {
    const { manager } = await bootManager();

    const result = await submit(manager.client, { plan_note_id: randomUUID(), questions: [technical('q1')] });

    expect(rawText(result)).toMatch(/^error note_not_found: /);
  });

  it('refuses a batch that repeats a question id with invalid_body and writes nothing', async () => {
    const { manager, planNote } = await bootManager();

    const result = await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1'), technical('q1')] });

    expect(rawText(result)).toMatch(/^error invalid_body: .*q1/);
    expect(questionRows()).toEqual([]);
  });

  it('records the revision of the plan note the batch was filed against', async () => {
    const { manager, planNote } = await bootManager();

    const { batch_id } = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1')] }));

    expect(daemon.db.prepare('SELECT manager_id, ticket, plan_note_id, plan_note_rev FROM plan_question_batches WHERE id = ?').get(batch_id))
      .toEqual({ manager_id: manager.id, ticket: TICKET, plan_note_id: planNote.id, plan_note_rev: 1 });
  });

  it('A21: the daemon wires the escalation service itself, so the tool answers on the daemon that startDaemon built', async () => {
    const { manager } = await bootManager();

    const toolNames = (await manager.client.listTools()).tools.map((tool) => tool.name);

    expect(toolNames).toContain('submit_plan_questions');
  });
});
