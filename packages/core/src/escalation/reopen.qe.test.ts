import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_ESCALATION_POLICY, type EscalationPolicy } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const TICKET = 'CCM-123';
const OTHER_TICKET = 'CCM-456';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;

let daemon: Daemon;
let config: ReturnType<typeof loadConfig>;
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
  const client = new Client({ name: 'reopen-qe', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenOf(sessionId)}` } } }));
  return client;
}

async function aNote(title: string): Promise<{ id: string }> {
  const response = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title, bodyMd: `# ${title}\n\n## Plan\n\nthe plan` }) });
  const created = (await response.json()) as { id?: string; data?: { id: string } };
  return { id: created.id ?? created.data!.id };
}

async function bootManager() {
  const root = await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: worktreesRoot, name: 'Root', harness: 'fake', emoji: '🤖', projectId: PROJECT_ID }) });
  const rootClient = await connect(((await root.json()) as { id: string }).id);
  const directory = join(worktreesRoot, `manager-${randomUUID()}`);
  mkdirSync(directory);
  const created = parsed(await rootClient.callTool({ name: 'create_session', arguments: { directory, name: 'Spawned', allow_duplicate: true, manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 } } }));
  const client = await connect(created.id);
  await client.callTool({ name: 'get_manager_base', arguments: {} });
  await client.callTool({ name: 'bootstrap_project_profile', arguments: {} });
  return { manager: { id: created.id as string, client }, planNote: await aNote('Plan') };
}

const technical = (id: string, text = `how to name the helper ${id}`) => ({ id, text, class: 'technical' });
const provenEvidence = { claim: 'the other helper is faster', status: 'proven', command: 'pnpm bench', output: 'old: 3ms new: 1ms' };
const reopening = (id: string, reopens: string, override: Json = {}) => ({ ...technical(id), reopens, resolution: provenEvidence, ...override });
const submit = (client: Client, input: Json, ticket = TICKET) => client.callTool({ name: 'submit_plan_questions', arguments: { ticket, ...input } });

const decided = (questionId: string) => ({ question_id: questionId, verdict: 'decided', decision: `use the plain name for ${questionId}`, rationale: `it reads best, ${questionId}` });
const opinion = (batchId: string, decisions: unknown[]) => ({ batch_id: batchId, decisions, criteria: { opinion: 'not_asked', reasons: [] } });
const report = (client: Client, input: Json) => client.callTool({ name: 'report_arbiter_opinion', arguments: input });

interface SessionRow { id: string; state: string; seeded_prompt: string | null }
const arbiterRows = (): SessionRow[] => daemon.db.prepare("SELECT * FROM sessions WHERE role = 'arbiter' ORDER BY created_at, rowid").all() as unknown as SessionRow[];
const waitForArbiters = async (count: number): Promise<SessionRow[]> => {
  await vi.waitFor(() => expect(arbiterRows()).toHaveLength(count), { timeout: 5000 });
  return arbiterRows();
};

interface QuestionRow { batch_id: string; question_id: string; route: string; status: string; reason: string | null; escalation_id: string | null; reopens_batch_id: string | null; reopens_question_id: string | null }
const questionRows = (): QuestionRow[] => daemon.db.prepare('SELECT * FROM plan_questions ORDER BY rowid').all() as unknown as QuestionRow[];
const rowsOf = (questionId: string) => questionRows().filter((row) => row.question_id === questionId);
const rowOf = (questionId: string) => rowsOf(questionId).at(-1)!;
const escalationRows = () => daemon.db.prepare('SELECT * FROM escalations').all() as { id: string; status: string }[];
const arbiterRunsOf = (batchId: string) => (daemon.db.prepare('SELECT arbiter_runs FROM plan_question_batches WHERE id = ?').get(batchId) as { arbiter_runs: number }).arbiter_runs;
const questionsForHumanOf = (managerId: string): string[] => {
  const row = daemon.db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(managerId) as { sections_json: string } | undefined;
  return row ? (JSON.parse(row.sections_json) as { questionsForHuman: string[] }).questionsForHuman : [];
};
const setPolicy = (policy: Partial<EscalationPolicy>) =>
  daemon.db.prepare('UPDATE projects SET escalation_policy_json = ? WHERE id = ?').run(JSON.stringify({ ...DEFAULT_ESCALATION_POLICY, ...policy }), PROJECT_ID);

type Manager = Awaited<ReturnType<typeof bootManager>>;

/** Submits the questions, lets the next arbiter decide them all, and answers the batch id. */
async function submitAndDecide({ manager, planNote }: Manager, questions: Json[], ticket = TICKET): Promise<string> {
  const arbitersBefore = arbiterRows().length;
  const answer = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions }, ticket));
  const arbiters = await waitForArbiters(arbitersBefore + 1);
  const arbiterClient = await connect(arbiters.at(-1)!.id);
  const result = await report(arbiterClient, opinion(answer.batch_id, questions.map(({ id }) => decided(id as string))));
  expect(result.isError).toBeFalsy();
  return answer.batch_id;
}

beforeEach(async () => {
  clients = [];
  const home = directories.make('reopen-qe-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } }, arbiter: { schedule: () => () => {} } });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('QE — one reopen of an arbiter decision, then a dispute for the human (F8A, A12)', () => {
  it('A12: accepts one reopen with new evidence, sends the second disagreement to the human as arbiter_dispute, and allows no third round', async () => {
    const booted = await bootManager();
    const { manager, planNote } = booted;
    const firstBatchId = await submitAndDecide(booted, [technical('q1')]);
    expect(rowOf('q1').status).toBe('decided');

    const reopened = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [reopening('n1', 'q1')] }));

    expect(reopened.arbiter).toEqual({ status: 'pending', question_ids: ['n1'] });
    expect(reopened.human).toBeNull();
    expect(rowOf('n1')).toMatchObject({ route: 'arbiter', status: 'open', reopens_batch_id: firstBatchId, reopens_question_id: 'q1' });
    const secondArbiter = (await waitForArbiters(2)).at(-1)!;
    expect(secondArbiter.seeded_prompt).toContain('use the plain name for q1');
    expect(secondArbiter.seeded_prompt).toContain('pnpm bench');
    expect(escalationRows()).toHaveLength(0);
    await report(await connect(secondArbiter.id), opinion(reopened.batch_id, [decided('n1')]));
    expect(rowOf('n1').status).toBe('decided');

    const disputed = parsed(await submit(manager.client, { plan_note_id: planNote.id, questions: [reopening('n2', 'n1')] }));

    expect(disputed.human).toEqual({ escalation_id: expect.any(String), question_ids: ['n2'] });
    expect(disputed.arbiter).toEqual({ status: 'pending', question_ids: [] });
    expect(rowOf('n2')).toMatchObject({ route: 'human', status: 'pending_human', reason: 'arbiter_dispute', reopens_question_id: 'n1' });
    expect(arbiterRows()).toHaveLength(2);
    expect(arbiterRunsOf(disputed.batch_id)).toBe(0);
    expect(escalationRows()).toEqual([expect.objectContaining({ id: disputed.human.escalation_id, status: 'pending' })]);
    expect(questionsForHumanOf(manager.id).filter((item) => item.startsWith('[esc:'))).toHaveLength(1);

    const rowCountBeforeThirdRound = questionRows().length;
    const thirdRounds = [reopening('n3', 'n2'), reopening('n4', 'n1'), reopening('n5', 'q1')];
    for (const thirdRound of thirdRounds) {
      const refusal = await submit(manager.client, { plan_note_id: planNote.id, questions: [thirdRound] });
      expect(refusal.isError).toBe(true);
    }
    expect(questionRows()).toHaveLength(rowCountBeforeThirdRound);
    expect(arbiterRows()).toHaveLength(2);
    expect(escalationRows()).toHaveLength(1);
  });

  it('refuses a reopen without executed evidence and stores nothing', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);
    const rowCount = questionRows().length;
    const withoutEvidence = { ...technical('n1'), reopens: 'q1' };
    const notRun = reopening('n1', 'q1', { resolution: { claim: 'maybe faster', status: 'not_reproduced' } });

    const missing = await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [withoutEvidence] });
    const unexecuted = await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [notRun] });

    expect(missing.isError).toBe(true);
    expect(rawText(missing)).toContain('resolution');
    expect(unexecuted.isError).toBe(true);
    expect(questionRows()).toHaveLength(rowCount);
  });

  it('refuses a reopen of a question id that does not exist', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);

    const refusal = await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'nope')] });

    expect(refusal.isError).toBe(true);
    expect(rawText(refusal)).toContain(`n1: reopens nope, but the arbiter decided no question with this id on ${TICKET}`);
    expect(rowsOf('n1')).toHaveLength(0);
  });

  it('refuses a reopen of a question the arbiter has not decided: a question that waits for the arbiter or a human is not reopenable', async () => {
    const { manager, planNote } = await bootManager();
    await submit(manager.client, { plan_note_id: planNote.id, questions: [technical('q1'), { id: 'q2', text: 'may we bump the contract_version?', class: 'contract' }] });

    const reopenOpen = await submit(manager.client, { plan_note_id: planNote.id, questions: [reopening('n1', 'q1')] });
    const reopenHuman = await submit(manager.client, { plan_note_id: planNote.id, questions: [reopening('n2', 'q2')] });

    expect(reopenOpen.isError).toBe(true);
    expect(reopenHuman.isError).toBe(true);
    expect(rawText(reopenOpen)).toContain(`n1: reopens q1, but the arbiter decided no question with this id on ${TICKET}`);
    expect(rawText(reopenHuman)).toContain(`n2: reopens q2, but the arbiter decided no question with this id on ${TICKET}`);
    expect(rowsOf('n1')).toHaveLength(0);
    expect(rowsOf('n2')).toHaveLength(0);
  });

  it('refuses a reopen of a decision taken on another ticket', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')], OTHER_TICKET);

    const refusal = await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1')] }, TICKET);

    expect(refusal.isError).toBe(true);
    expect(rawText(refusal)).toContain(`n1: reopens q1, but the arbiter decided no question with this id on ${TICKET}`);
    expect(rowsOf('n1')).toHaveLength(0);
  });

  it('refuses a reopen of a decision taken for another manager', async () => {
    const first = await bootManager();
    await submitAndDecide(first, [technical('q1')]);
    const second = await bootManager();

    const refusal = await submit(second.manager.client, { plan_note_id: second.planNote.id, questions: [reopening('n1', 'q1')] });

    expect(refusal.isError).toBe(true);
    expect(rawText(refusal)).toContain(`n1: reopens q1, but the arbiter decided no question with this id on ${TICKET}`);
    expect(rowsOf('n1')).toHaveLength(0);
  });

  it('refuses two questions of one batch that reopen the same decision', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);

    const refusal = await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1'), reopening('n2', 'q1')] });

    expect(refusal.isError).toBe(true);
    expect(rawText(refusal)).toContain('n2: the arbiter decision of q1 was already reopened once');
    expect(rowsOf('n1')).toHaveLength(0);
    expect(rowsOf('n2')).toHaveLength(0);
  });

  it('targets the most recent decided question when an id repeats across two batches, never the stale older one', async () => {
    const booted = await bootManager();
    const olderBatchId = await submitAndDecide(booted, [technical('q1')]);
    const newerBatchId = await submitAndDecide(booted, [technical('q1', 'how to name the helper, second batch')]);

    const reopened = parsed(await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1')] }));

    expect(rowOf('n1')).toMatchObject({ reopens_batch_id: newerBatchId, reopens_question_id: 'q1' });
    expect(rowOf('n1').reopens_batch_id).not.toBe(olderBatchId);
    const secondReopen = await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n2', 'q1')] });
    expect(secondReopen.isError).toBe(true);
    expect(rowsOf('n2')).toHaveLength(0);
    expect(reopened.arbiter.status).toBe('pending');
  });

  it('counts the reopen against the arbiter runs of the ticket: with the quota used up it goes to the human as arbiter_quota', async () => {
    setPolicy({ maxArbiterRunsPerTicket: 1 });
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);

    const reopened = parsed(await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1')] }));

    expect(reopened.arbiter).toMatchObject({ status: 'escalated', reason: 'arbiter_quota' });
    expect(rowOf('n1')).toMatchObject({ status: 'pending_human', reason: 'arbiter_quota' });
    expect(arbiterRows()).toHaveLength(1);
  });

  it('keeps a floor-escalating reopen on the human list: the floor classes still apply', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);

    const reopened = parsed(await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1', { text: 'do we bump the contract_version after all?' })] }));

    expect(reopened.human.question_ids).toEqual(['n1']);
    expect(rowOf('n1')).toMatchObject({ route: 'human', status: 'pending_human', reopens_question_id: 'q1' });
    expect(arbiterRows()).toHaveLength(1);
  });

  it('puts the earlier decision under the reopens key of the question line, after the data marker, never in the header', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);

    await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1')] });

    const prompt = (await waitForArbiters(2)).at(-1)!.seeded_prompt!;
    const dataMarkerAt = prompt.indexOf('--- BEGIN QUESTIONS');
    const endMarkerAt = prompt.indexOf('--- END QUESTIONS ---');
    const earlierDecisionAt = prompt.indexOf('"reopens":{"question_id":"q1","earlier_decision":"use the plain name for q1","earlier_rationale":"it reads best, q1"}');
    expect(dataMarkerAt).toBeGreaterThan(-1);
    expect(earlierDecisionAt).toBeGreaterThan(dataMarkerAt);
    expect(earlierDecisionAt).toBeLessThan(endMarkerAt);
    expect(prompt.slice(0, dataMarkerAt)).not.toContain('use the plain name for q1');
  });

  it('hands a reopen to the human when the arbiter answers it needs_human', async () => {
    const booted = await bootManager();
    await submitAndDecide(booted, [technical('q1')]);
    const reopened = parsed(await submit(booted.manager.client, { plan_note_id: booted.planNote.id, questions: [reopening('n1', 'q1')] }));
    const secondArbiter = (await waitForArbiters(2)).at(-1)!;
    const needsHuman = { question_id: 'n1', verdict: 'needs_human', decision: 'a human should settle the name', rationale: 'both names are defensible' };

    const result = await report(await connect(secondArbiter.id), opinion(reopened.batch_id, [needsHuman]));

    expect(result.isError).toBeFalsy();
    expect(rowOf('n1')).toMatchObject({ route: 'arbiter', status: 'pending_human', reason: 'arbiter_deferred', reopens_question_id: 'q1' });
    expect(escalationRows()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(questionsForHumanOf(booted.manager.id).filter((item) => item.startsWith('[esc:'))).toHaveLength(1);
  });
});
