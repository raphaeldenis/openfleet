import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type EscalationView } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const TICKET = 'CCM-123';

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;
type Frame = { type: string } & Json;

let daemon: Daemon;
let adminToken: string;
let worktreesRoot: string;
let clients: Client[];
let sockets: WebSocket[];
const directories = createTempDirTracker();

const rawText = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));
const tokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;

const adminApi = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...options.headers },
});
const answerWith = (escalationId: string, answers: unknown, headers: Record<string, string> = {}) =>
  adminApi(`/api/escalations/${escalationId}/answer`, { method: 'POST', body: JSON.stringify({ answers }), headers });

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'escalation-routes-qe', version: '1' });
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

async function bootManager() {
  const root = await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: worktreesRoot, name: 'Root', harness: 'fake', emoji: '🤖', projectId: PROJECT_ID }) });
  const rootClient = await connect(((await root.json()) as { id: string }).id);
  const manager = await spawn(rootClient, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 } });
  await manager.client.callTool({ name: 'get_manager_base', arguments: {} });
  const note = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title: 'Plan', bodyMd: '# Plan\n\n## Plan\n\nthe plan' }) });
  const created = (await note.json()) as { id?: string; data?: { id: string } };
  return { manager, planNoteId: created.id ?? created.data!.id };
}

type Booted = Awaited<ReturnType<typeof bootManager>>;

const contractQuestion = (id: string, text = 'may we bump the contract_version?') => ({ id, text, class: 'contract', options: ['yes', 'no'], recommendation: 'no' });
const submit = (booted: Booted, questions: Json[], ticket = TICKET) =>
  booted.manager.client.callTool({ name: 'submit_plan_questions', arguments: { ticket, plan_note_id: booted.planNoteId, questions } });
async function submitAndReadEscalationId(booted: Booted, questions: Json[], ticket = TICKET): Promise<string> {
  const answer = parsed(await submit(booted, questions, ticket));
  return answer.human.escalation_id as string;
}

async function openSocket(): Promise<{ socket: WebSocket; frames: Frame[]; framesOfType: (type: string) => Frame[]; nextFrameOfType: (type: string, count?: number) => Promise<Frame> }> {
  const { ticket } = (await (await adminApi('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data)) as Frame));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const framesOfType = (type: string) => frames.filter((frame) => frame.type === type);
  const nextFrameOfType = async (type: string, count = 1) => {
    for (let attempt = 0; attempt < 100 && framesOfType(type).length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return framesOfType(type)[count - 1]!;
  };
  return { socket, frames, framesOfType, nextFrameOfType };
}

const queuedBodiesOf = (sessionId: string): string[] =>
  (daemon.db.prepare('SELECT body FROM message_queue WHERE session_id = ? ORDER BY created_at').all(sessionId) as { body: string }[]).map(({ body }) => body);
const questionStatuses = () => (daemon.db.prepare('SELECT question_id, status, human_answer FROM plan_questions ORDER BY rowid').all() as { question_id: string; status: string; human_answer: string | null }[]);

const questionsForHumanOf = (managerId: string): string[] => {
  const row = daemon.db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(managerId) as { sections_json: string } | undefined;
  return row ? (JSON.parse(row.sections_json) as { questionsForHuman: string[] }).questionsForHuman : [];
};
const escalationItemOf = (managerId: string, escalationId: string): string | undefined =>
  questionsForHumanOf(managerId).find((item) => item.startsWith(`[esc:${escalationId}]`));
const rewriteQuestionsForHuman = (manager: Booted['manager'], questions: string[]) =>
  manager.client.callTool({ name: 'update_working_state', arguments: { plan: [], todo: [], remaining: [], questions_for_human: questions, internal_questions: [], blockers: [] } });

beforeEach(async () => {
  clients = [];
  sockets = [];
  const home = directories.make('escalation-routes-qe-');
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
  for (const socket of sockets) socket.close();
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('QE — the escalation routes on a booted daemon', () => {
  describe('GET /api/escalations', () => {
    it('lists the pending escalations with the questions each one carries', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

      const response = await adminApi('/api/escalations');

      expect(response.status).toBe(200);
      const [escalation] = (await response.json()) as EscalationView[];
      expect(escalation).toMatchObject({
        id: escalationId, managerId: booted.manager.id, ticket: TICKET, status: 'pending', body: expect.stringContaining('may we bump the contract_version?'),
        questions: [{ questionId: 'q1', text: 'may we bump the contract_version?', effectiveClasses: ['contract'], options: ['yes', 'no'], recommendation: 'no', status: 'pending_human' }],
      });
    });

    it('lists only the pending ones by default and the answered ones on request', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
      await answerWith(escalationId, [{ question_id: 'q1', answer: 'no' }]);

      const pending = (await (await adminApi('/api/escalations')).json()) as EscalationView[];
      const answered = (await (await adminApi('/api/escalations?status=answered')).json()) as EscalationView[];

      expect(pending).toEqual([]);
      expect(answered.map(({ id, status }) => ({ id, status }))).toEqual([{ id: escalationId, status: 'answered' }]);
    });

    it('refuses a status outside pending and answered with invalid_query', async () => {
      const response = await adminApi('/api/escalations?status=banana');

      expect(response.status).toBe(400);
    });

    it('answers 401 to the MCP token of a session', async () => {
      const booted = await bootManager();

      const response = await adminApi('/api/escalations', { headers: { authorization: `Bearer ${tokenOf(booted.manager.id)}` } });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/managers/:id/escalations', () => {
    it('lists the escalations of that manager only', async () => {
      const first = await bootManager();
      const second = await bootManager();
      const firstEscalationId = await submitAndReadEscalationId(first, [contractQuestion('q1')]);
      await submitAndReadEscalationId(second, [contractQuestion('q1')]);

      const listed = (await (await adminApi(`/api/managers/${first.manager.id}/escalations`)).json()) as EscalationView[];

      expect(listed.map(({ id }) => id)).toEqual([firstEscalationId]);
    });

    it('answers manager_not_found for a session that is not a manager', async () => {
      const booted = await bootManager();
      const child = await spawn(booted.manager.client);

      const response = await adminApi(`/api/managers/${child.id}/escalations`);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'manager_not_found' });
    });
  });

  describe('POST /api/escalations/:id/answer', () => {
    it('answers every question, closes the escalation and keeps what the human wrote', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1'), contractQuestion('q2', 'may we add a migration?')]);

      const response = await answerWith(escalationId, [{ question_id: 'q1', answer: 'no, keep version 13' }, { question_id: 'q2', answer: 'yes, one migration' }]);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: escalationId, status: 'answered', resolvedAt: expect.any(String),
        questions: [{ questionId: 'q1', status: 'answered', humanAnswer: 'no, keep version 13' }, { questionId: 'q2', status: 'answered', humanAnswer: 'yes, one migration' }],
      });
      expect(questionStatuses()).toEqual([{ question_id: 'q1', status: 'answered', human_answer: 'no, keep version 13' }, { question_id: 'q2', status: 'answered', human_answer: 'yes, one migration' }]);
    });

    describe('the [esc:<id>] item in the questions_for_human of the manager', () => {
      const answerQ1 = (escalationId: string) => answerWith(escalationId, [{ question_id: 'q1', answer: 'no, keep version 13' }]);

      it('removes the item of the answered escalation and leaves the other items untouched', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        const itemOfOtherEscalation = '[esc:other] Escalation on CCM-9: a human answer is needed, see the Inbox';
        await rewriteQuestionsForHuman(booted.manager, [...questionsForHumanOf(booted.manager.id), 'A free question', itemOfOtherEscalation]);

        await answerQ1(escalationId);

        expect(escalationItemOf(booted.manager.id, escalationId)).toBeUndefined();
        expect(questionsForHumanOf(booted.manager.id)).toEqual(['A free question', itemOfOtherEscalation]);
      });

      it('is safe when the answer is sent twice: the second answer is refused and the other items stay', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        await rewriteQuestionsForHuman(booted.manager, [...questionsForHumanOf(booted.manager.id), 'A free question']);
        await answerQ1(escalationId);

        const secondAnswer = await answerQ1(escalationId);

        expect(secondAnswer.status).toBe(409);
        expect(questionsForHumanOf(booted.manager.id)).toEqual(['A free question']);
      });

      it('answers without error when the manager already removed the item, and keeps what the manager wrote', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        await rewriteQuestionsForHuman(booted.manager, ['A free question']);

        const response = await answerQ1(escalationId);

        expect(response.status).toBe(200);
        expect(questionsForHumanOf(booted.manager.id)).toEqual(['A free question']);
      });

      it('answers without error when the manager has no working state anymore', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        daemon.db.prepare('DELETE FROM session_working_states WHERE session_id = ?').run(booted.manager.id);

        const response = await answerQ1(escalationId);

        expect(response.status).toBe(200);
        expect(questionsForHumanOf(booted.manager.id)).toEqual([]);
      });

      it('does not bring the item back when a retry-handover arrives after the answer: the retry is refused', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        await answerQ1(escalationId);

        const retry = await adminApi(`/api/escalations/${escalationId}/retry-handover`, { method: 'POST', body: '{}' });

        expect(retry.status).toBe(409);
        expect(await retry.json()).toMatchObject({ error: 'already_resolved' });
        expect(escalationItemOf(booted.manager.id, escalationId)).toBeUndefined();
      });

      it('lists a later escalation of the same ticket under its own id and does not bring the answered one back', async () => {
        const booted = await bootManager();
        const answeredId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        await answerQ1(answeredId);

        const laterId = await submitAndReadEscalationId(booted, [contractQuestion('q2', 'may we add a migration?')]);

        expect(laterId).not.toBe(answeredId);
        expect(escalationItemOf(booted.manager.id, answeredId)).toBeUndefined();
        expect(escalationItemOf(booted.manager.id, laterId)).toBeDefined();
      });

      it('removes only its own item when another id starts with the same characters', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        const itemOfLongerId = `[esc:${escalationId}0] Escalation on CCM-9: a human answer is needed, see the Inbox`;
        await rewriteQuestionsForHuman(booted.manager, [...questionsForHumanOf(booted.manager.id), itemOfLongerId]);

        await answerQ1(escalationId);

        expect(questionsForHumanOf(booted.manager.id)).toEqual([itemOfLongerId]);
      });

      it('finishes the answer, tells the manager and warns when the item cannot be removed', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
        const { framesOfType, nextFrameOfType } = await openSocket();
        daemon.db.exec(`CREATE TRIGGER refuse_working_state_update BEFORE UPDATE ON session_working_states BEGIN SELECT RAISE(ABORT, 'working state is read-only'); END`);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const response = await answerQ1(escalationId);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: escalationId, status: 'answered' });
        await nextFrameOfType('escalation.resolved');
        expect(framesOfType('escalation.resolved')).toHaveLength(1);
        expect(queuedBodiesOf(booted.manager.id).some((body) => body.includes(`Escalation ${escalationId}`))).toBe(true);
        expect(warn.mock.calls.some(([line]) => String(line).includes('could not be removed'))).toBe(true);
        warn.mockRestore();
      });

      it('leaves the item of an escalation whose answer is refused', async () => {
        const booted = await bootManager();
        const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

        const response = await answerWith(escalationId, [{ question_id: 'unknown', answer: 'x' }]);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(escalationItemOf(booted.manager.id, escalationId)).toBeDefined();
      });
    });

    it('A13: refuses the MCP token of the manager with 401 unauthorized and leaves the escalation pending', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

      const response = await answerWith(escalationId, [{ question_id: 'q1', answer: 'yes, go' }], { authorization: `Bearer ${tokenOf(booted.manager.id)}` });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
      expect(questionStatuses()).toEqual([{ question_id: 'q1', status: 'pending_human', human_answer: null }]);
    });

    it('refuses a second answer with already_resolved and keeps the first one', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
      await answerWith(escalationId, [{ question_id: 'q1', answer: 'first' }]);

      const second = await answerWith(escalationId, [{ question_id: 'q1', answer: 'second' }]);

      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: 'already_resolved' });
      expect(questionStatuses()).toEqual([{ question_id: 'q1', status: 'answered', human_answer: 'first' }]);
    });

    it('answers escalation_not_found for an id that does not exist', async () => {
      const response = await answerWith(randomUUID(), [{ question_id: 'q1', answer: 'x' }]);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'escalation_not_found' });
    });

    it.each([
      ['a question left without an answer', [{ question_id: 'q1', answer: 'no' }]],
      ['an answer to a question the escalation does not carry', [{ question_id: 'q1', answer: 'no' }, { question_id: 'q2', answer: 'no' }, { question_id: 'q9', answer: 'no' }]],
      ['two answers to one question', [{ question_id: 'q1', answer: 'no' }, { question_id: 'q1', answer: 'yes' }, { question_id: 'q2', answer: 'no' }]],
      ['an empty answer', [{ question_id: 'q1', answer: '   ' }, { question_id: 'q2', answer: 'no' }]],
    ])('refuses %s with invalid_body and answers nothing', async (_label, answers) => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1'), contractQuestion('q2', 'may we add a migration?')]);

      const response = await answerWith(escalationId, answers);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_body' });
      expect(questionStatuses().map(({ status }) => status)).toEqual(['pending_human', 'pending_human']);
    });

    it('tells the manager what the human answered, with the escalation id and the ticket', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

      await answerWith(escalationId, [{ question_id: 'q1', answer: 'no, keep version 13' }]);

      const notification = queuedBodiesOf(booted.manager.id).find((body) => body.includes(`Escalation ${escalationId}`));
      expect(notification).toContain(TICKET);
      expect(notification).toContain('q1');
      expect(notification).toContain('no, keep version 13');
    });

    it('masks a secret the human typed in the message to the manager', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
      const fakeToken = ['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789';

      await answerWith(escalationId, [{ question_id: 'q1', answer: `use ${fakeToken}` }]);

      const notification = queuedBodiesOf(booted.manager.id).find((body) => body.includes(`Escalation ${escalationId}`));
      expect(notification).not.toContain(fakeToken);
    });
  });

  describe('WebSocket events', () => {
    it('sends escalation.raised when the first escalating question opens an escalation', async () => {
      const booted = await bootManager();
      const { nextFrameOfType } = await openSocket();

      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

      const raised = await nextFrameOfType('escalation.raised');
      expect(raised.escalation).toMatchObject({ id: escalationId, managerId: booted.manager.id, ticket: TICKET, status: 'pending', questions: [{ questionId: 'q1' }] });
    });

    it('A1: five technical questions and one contract question raise exactly one event', async () => {
      const booted = await bootManager();
      const { framesOfType, nextFrameOfType } = await openSocket();
      const technical = ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => ({ id, text: `how to name the helper ${id}`, class: 'technical' }));

      await submit(booted, [...technical, contractQuestion('q6')]);

      await nextFrameOfType('escalation.raised');
      expect(framesOfType('escalation.raised')).toHaveLength(1);
    });

    it('sends the rebuilt escalation again when a later batch of the ticket joins it', async () => {
      const booted = await bootManager();
      const { nextFrameOfType } = await openSocket();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

      await submit(booted, [{ id: 'q9', text: 'may we waive the criterion', class: 'dod_waiver' }]);

      const joined = await nextFrameOfType('escalation.raised', 2);
      expect(joined.escalation).toMatchObject({ id: escalationId, questions: [{ questionId: 'q1' }, { questionId: 'q9' }] });
    });

    it('sends nothing for a batch that needs no human', async () => {
      const booted = await bootManager();
      const { framesOfType } = await openSocket();

      await submit(booted, [{ id: 'q1', text: 'how to name the helper', class: 'technical' }]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(framesOfType('escalation.raised')).toEqual([]);
    });

    it('sends escalation.resolved with the answers when the human answers', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
      const { nextFrameOfType } = await openSocket();

      await answerWith(escalationId, [{ question_id: 'q1', answer: 'no' }]);

      const resolved = await nextFrameOfType('escalation.resolved');
      expect(resolved.escalation).toMatchObject({ id: escalationId, status: 'answered', questions: [{ questionId: 'q1', status: 'answered', humanAnswer: 'no' }] });
    });

    it('sends no event for an answer that is refused', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
      const { framesOfType } = await openSocket();

      await answerWith(escalationId, [{ question_id: 'q1', answer: '' }]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(framesOfType('escalation.resolved')).toEqual([]);
    });
  });

  describe('snapshot.escalations', () => {
    it('carries the pending escalations to a client that connects after they were raised', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

      const { nextFrameOfType } = await openSocket();

      const snapshot = await nextFrameOfType('snapshot');
      expect((snapshot.escalations as EscalationView[]).map(({ id }) => id)).toEqual([escalationId]);
    });

    it('is an empty list, not a missing field, when nothing is pending', async () => {
      const { nextFrameOfType } = await openSocket();

      const snapshot = await nextFrameOfType('snapshot');

      expect(snapshot.escalations).toEqual([]);
    });

    it('no longer carries an escalation once it is answered', async () => {
      const booted = await bootManager();
      const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);
      await answerWith(escalationId, [{ question_id: 'q1', answer: 'no' }]);

      const { nextFrameOfType } = await openSocket();

      const snapshot = await nextFrameOfType('snapshot');
      expect(snapshot.escalations).toEqual([]);
    });
  });

  it('A21: the routes use the escalation service the daemon container built', async () => {
    const booted = await bootManager();
    const escalationId = await submitAndReadEscalationId(booted, [contractQuestion('q1')]);

    const [listed] = (await (await adminApi('/api/escalations')).json()) as EscalationView[];

    expect(listed!.id).toBe(escalationId);
  });
});
