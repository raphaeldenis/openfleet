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
const WATCHING_PULSE_SECONDS = 3600;

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Json = Record<string, unknown>;
interface Frame { type: string; escalation?: { id: string; managerId: string; ticket: string; status: string; body: string; questions: { questionId: string; status: string; reason?: string }[] } }

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

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'escalation-raised-qe', version: '1' });
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
  const manager = await spawn(rootClient, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: WATCHING_PULSE_SECONDS } });
  await manager.client.callTool({ name: 'get_manager_base', arguments: {} });
  await manager.client.callTool({ name: 'bootstrap_project_profile', arguments: {} });
  const created = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title: 'Plan', bodyMd: '# Plan\n\n## Plan\n\nthe plan' }) });
  const note = (await created.json()) as { id?: string; data?: { id: string } };
  return { manager, planNoteId: note.id ?? note.data!.id };
}

type Booted = Awaited<ReturnType<typeof bootManager>>;

async function openSocket() {
  const { ticket } = (await (await adminApi('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data)) as Frame));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const raisedFrames = () => frames.filter((frame) => frame.type === 'escalation.raised');
  return { raisedFrames };
}

const technical = (id: string) => ({ id, text: `how to name the helper ${id}`, class: 'technical' });
const submit = (booted: Booted, questions: Json[]) =>
  booted.manager.client.callTool({ name: 'submit_plan_questions', arguments: { ticket: TICKET, plan_note_id: booted.planNoteId, questions } });
const decided = (questionId: string) => ({ question_id: questionId, verdict: 'decided', decision: `use the plain name for ${questionId}`, rationale: `it reads best, ${questionId}` });
const report = (client: Client, batchId: string, decisions: unknown[]) =>
  client.callTool({ name: 'report_arbiter_opinion', arguments: { batch_id: batchId, decisions, criteria: { opinion: 'not_asked', reasons: [] } } });

const arbiterIds = (): string[] => (daemon.db.prepare("SELECT id FROM sessions WHERE role = 'arbiter' ORDER BY created_at, rowid").all() as { id: string }[]).map(({ id }) => id);
const waitForArbiters = async (count: number): Promise<string[]> => {
  await vi.waitFor(() => expect(arbiterIds()).toHaveLength(count), { timeout: 5000 });
  return arbiterIds();
};
const closeSession = (sessionId: string) => adminApi(`/api/sessions/${sessionId}/close`, { method: 'POST', body: '{}' });
const setPolicy = (policy: Partial<EscalationPolicy>) =>
  daemon.db.prepare('UPDATE projects SET escalation_policy_json = ? WHERE id = ?').run(JSON.stringify({ ...DEFAULT_ESCALATION_POLICY, ...policy }), PROJECT_ID);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeEach(async () => {
  clients = [];
  sockets = [];
  const home = directories.make('escalation-raised-qe-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  const neverExpires = () => () => {};
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } }, arbiter: { schedule: neverExpires } });
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  for (const client of clients) await client.close();
  await daemon.close();
  daemon.db.close();
  directories.removeAll();
});

describe('QE — escalation.raised reaches the UI on every path that opens or changes the open escalation of a ticket', () => {
  it('sends escalation.raised when a lost arbiter hands the technical questions to the human', async () => {
    const booted = await bootManager();
    const { raisedFrames } = await openSocket();
    await submit(booted, [technical('q1'), technical('q2')]);
    const [first] = await waitForArbiters(1);

    await closeSession(first!);
    const [, second] = await waitForArbiters(2);
    await closeSession(second!);

    await vi.waitFor(() => expect(raisedFrames()).toHaveLength(1), { timeout: 5000 });
    expect(raisedFrames()[0]!.escalation).toMatchObject({ managerId: booted.manager.id, ticket: TICKET, status: 'pending', questions: [{ questionId: 'q1', reason: 'arbiter_unavailable' }, { questionId: 'q2', reason: 'arbiter_unavailable' }] });
  });

  it('sends escalation.raised when the arbiter quota hands the next batch of the ticket to the human', async () => {
    setPolicy({ maxArbiterRunsPerTicket: 1 });
    const booted = await bootManager();
    const { raisedFrames } = await openSocket();
    await submit(booted, [technical('q1')]);
    await waitForArbiters(1);
    await settle();
    expect(raisedFrames()).toEqual([]);

    await submit(booted, [technical('q2')]);

    await vi.waitFor(() => expect(raisedFrames()).toHaveLength(1), { timeout: 5000 });
    expect(raisedFrames()[0]!.escalation).toMatchObject({ ticket: TICKET, questions: [{ questionId: 'q2', reason: 'arbiter_quota' }] });
  });

  it('sends the rebuilt escalation when the opinion of the arbiter hands questions to the human with needs_human and raise_to', async () => {
    const booted = await bootManager();
    const { raisedFrames } = await openSocket();
    const answer = parsed(await submit(booted, [technical('q1'), technical('q2'), technical('q3')]));
    const [arbiter] = await waitForArbiters(1);

    await report(await connect(arbiter!), answer.batch_id, [
      decided('q1'),
      { question_id: 'q2', verdict: 'needs_human', decision: 'only a human can weigh this', rationale: 'it changes who pays' },
      { question_id: 'q3', verdict: 'decided', decision: 'touches the token store', rationale: 'security relevant', raise_to: 'security' },
    ]);

    await vi.waitFor(() => expect(raisedFrames()).toHaveLength(1), { timeout: 5000 });
    expect(raisedFrames()[0]!.escalation).toMatchObject({ managerId: booted.manager.id, ticket: TICKET, status: 'pending', questions: [{ questionId: 'q2', status: 'pending_human' }, { questionId: 'q3', status: 'pending_human' }] });
  });

  it('sends nothing when the opinion of the arbiter decides every question: no escalation changed', async () => {
    const booted = await bootManager();
    const { raisedFrames } = await openSocket();
    const answer = parsed(await submit(booted, [technical('q1')]));
    const [arbiter] = await waitForArbiters(1);

    await report(await connect(arbiter!), answer.batch_id, [decided('q1')]);
    await settle();

    expect(raisedFrames()).toEqual([]);
  });
});
