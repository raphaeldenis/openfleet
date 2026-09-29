import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, WorkingState, WorkingStateSections } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { startServer } from './server.js';

const MAX_BYTES = 6144;
const DEFAULT_MAX_AGE_MINUTES = 30;

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let workingStates: WorkingStateService;
let tick = 0;

const sections = (overrides: Partial<WorkingStateSections> = {}): WorkingStateSections => ({
  plan: ['p'], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [], ...overrides,
});

async function startTestServer({ withWorkingStates }: { withWorkingStates: boolean }) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  workingStates = new WorkingStateService({ db, clock: () => new Date(Date.UTC(2026, 8, 30, 10, 0, tick++)).toISOString(), stateRoot: mkdtempSync(join(tmpdir(), 'of-ws-hostile-')), maxBytes: MAX_BYTES });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json',
    ...(withWorkingStates ? { workingStates } : {}),
  });
}

beforeEach(async () => {
  tick = 0;
  await startTestServer({ withWorkingStates: true });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const createSession = (name = 'Dev', parentId?: string) => sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🤖', ...(parentId ? { parentId } : {}) });

interface Connection { ws: WebSocket; received: ServerEvent[]; snapshot: Required<Extract<ServerEvent, { type: 'snapshot' }>> }

async function connect(): Promise<Connection> {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  const received: ServerEvent[] = [];
  const firstFrame = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve(), { once: true }));
  ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
  await firstFrame;
  return { ws, received, snapshot: received.shift() as Connection['snapshot'] };
}

async function settle(connection: Connection, sessionId: string): Promise<WorkingState[]> {
  const marker = new Promise<void>((resolve) => connection.ws.addEventListener('message', (message) => { if (JSON.parse(String(message.data)).type === 'session.updated') resolve(); }));
  sessions.rename(sessionId, { name: 'marker' });
  await marker;
  return connection.received.flatMap((event) => (event.type === 'session.working_state' ? [event.state] : []));
}

describe('working-state event isolation', () => {
  it('sends only the state of the session that updated, never another session state', async () => {
    const alpha = await createSession('Alpha');
    const beta = await createSession('Beta');
    workingStates.update(beta.id, sections({ plan: ['beta secret'] }));
    const connection = await connect();

    workingStates.update(alpha.id, sections({ plan: ['alpha only'] }));
    const states = await settle(connection, alpha.id);

    expect(states.map((state) => state.sessionId)).toEqual([alpha.id]);
    expect(JSON.stringify(states)).not.toContain('beta secret');
    connection.ws.close();
  });

  it('shows the same state over REST at the moment the event arrives', async () => {
    const session = await createSession();
    const connection = await connect();
    const eventArrived = new Promise<WorkingState>((resolve) => connection.ws.addEventListener('message', (message) => { const event = JSON.parse(String(message.data)); if (event.type === 'session.working_state') resolve(event.state); }));

    workingStates.update(session.id, sections({ plan: ['committed'] }));
    const fromEvent = await eventArrived;
    const fromRest = await (await api(`/api/sessions/${session.id}/working-state`)).json();

    expect(fromRest).toEqual(fromEvent);
    connection.ws.close();
  });
});

describe('working-state route under hostile ids', () => {
  it.each([
    ['path traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['encoded null byte', '%00'],
    ['quote injection', `${encodeURIComponent("' OR 1=1 --")}`],
    ['unicode', encodeURIComponent('会話-🤖')],
    ['a 8000 character id', 'a'.repeat(8000)],
  ])('answers not_found, not a server error, for %s', async (_label, id) => {
    const response = await api(`/api/sessions/${id}/working-state`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('answers 401, not 404, to an unauthenticated caller asking about a session that does not exist', async () => {
    const response = await fetch(`${server.url}/api/sessions/nope/working-state`);

    expect(response.status).toBe(401);
  });

  it('does not expose the route to POST', async () => {
    const session = await createSession();
    workingStates.update(session.id, sections());

    const response = await api(`/api/sessions/${session.id}/working-state`, { method: 'POST', body: '{}' });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('working-state without the service', () => {
  it('has no route and a snapshot with the default settings when the daemon hands over no service', async () => {
    await server.close();
    await startTestServer({ withWorkingStates: false });
    const session = await createSession();
    workingStates.update(session.id, sections());

    const response = await api(`/api/sessions/${session.id}/working-state`);
    const { ws, snapshot } = await connect();

    expect(response.status).toBe(404);
    expect(await response.json()).not.toEqual(expect.objectContaining({ plan: expect.anything() }));
    expect(snapshot.workingStates).toEqual([]);
    expect(snapshot.workingStateMaxAgeMinutes).toBe(DEFAULT_MAX_AGE_MINUTES);
    expect(snapshot.workingStateMaxBytes).toBe(MAX_BYTES);
    ws.close();
  });
});

describe('fleet events around odd parents', () => {
  it('does not crash and stays silent for a child whose parent id is unknown', async () => {
    const bystander = await createSession('Bystander');
    workingStates.update(bystander.id, sections());
    const connection = await connect();

    const orphan = await createSession('Orphan', 'no-such-parent').catch(() => undefined);
    if (orphan) await sessions.close(orphan.id);
    const states = await settle(connection, bystander.id);

    expect(states).toEqual([]);
    connection.ws.close();
  });

  it('still announces the state of a parent that is already closed when a child of it closes', async () => {
    const manager = await createSession('Lead');
    const child = await createSession('Child', manager.id);
    workingStates.update(manager.id, sections());
    await sessions.close(manager.id);
    const connection = await connect();

    await sessions.close(child.id);
    const states = await settle(connection, child.id);

    expect(states.every((state) => state.sessionId === manager.id)).toBe(true);
    expect(connection.snapshot.workingStates.map((state) => state.sessionId)).not.toContain(manager.id);
    connection.ws.close();
  });
});

describe('working-state load and size', () => {
  it('delivers 50 simultaneous updates of 50 sessions, each exactly once and with its own state', async () => {
    const created = await Promise.all(Array.from({ length: 50 }, (_, i) => createSession(`S${i}`)));
    const connection = await connect();

    await Promise.all(created.map(async (session, i) => workingStates.update(session.id, sections({ plan: [`state-${i}`] }))));
    const states = await settle(connection, created[0]!.id);

    expect(states).toHaveLength(50);
    expect(new Set(states.map((state) => state.sessionId)).size).toBe(50);
    states.forEach((state) => expect(state.plan[0]).toBe(`state-${created.findIndex((session) => session.id === state.sessionId)}`));
    connection.ws.close();
  });

  it('ends on the last of 50 updates of a single session', async () => {
    const session = await createSession();
    const connection = await connect();

    for (let i = 0; i < 50; i++) workingStates.update(session.id, sections({ plan: [`v${i}`] }));
    const states = await settle(connection, session.id);

    expect(states).toHaveLength(50);
    expect(states.map((state) => state.plan[0])).toEqual(Array.from({ length: 50 }, (_, i) => `v${i}`));
    connection.ws.close();
  });

  it('carries a unicode state right at the byte cap through REST, the event and the snapshot unchanged', async () => {
    const session = await createSession();
    const unicodeLine = '会話🤖é'.repeat(20);
    let lines: string[] = [];
    for (let count = 1; count < 200; count++) {
      const candidate = Array.from({ length: count }, (_, i) => `${i}${unicodeLine}`);
      try { workingStates.update(session.id, sections({ plan: candidate })); lines = candidate; } catch { break; }
    }
    const connection = await connect();
    workingStates.update(session.id, sections({ plan: lines }));
    const [eventState] = await settle(connection, session.id);
    const restState = await (await api(`/api/sessions/${session.id}/working-state`)).json();
    const late = await connect();

    expect(lines.length).toBeGreaterThan(1);
    expect(eventState!.plan).toEqual(lines);
    expect((restState as WorkingState).plan).toEqual(lines);
    expect(late.snapshot.workingStates[0]!.plan).toEqual(lines);
    connection.ws.close();
    late.ws.close();
  });

  it('gives a client connecting during an update the new state, from the snapshot or the event, never neither', async () => {
    const session = await createSession();
    workingStates.update(session.id, sections({ plan: ['old'] }));

    const connecting = connect();
    workingStates.update(session.id, sections({ plan: ['new'] }));
    const connection = await connecting;
    const states = await settle(connection, session.id);

    const seen = [...connection.snapshot.workingStates, ...states].map((state) => state.plan[0]);
    expect(seen.at(-1)).toBe('new');
    connection.ws.close();
  });

  it('builds the snapshot of 100 open sessions in a stable order and in a reasonable time', async () => {
    const created = [];
    for (let i = 0; i < 100; i++) created.push(await createSession(`S${i}`));
    created.forEach((session, i) => workingStates.update(session.id, sections({ plan: [`n${i}`] })));

    const startedAt = performance.now();
    const first = await connect();
    const elapsedMs = performance.now() - startedAt;
    const second = await connect();

    expect(first.snapshot.workingStates).toHaveLength(100);
    expect(first.snapshot.workingStates.map((state) => state.sessionId)).toEqual(second.snapshot.workingStates.map((state) => state.sessionId));
    expect(first.snapshot.workingStates.map((state) => state.sessionId)).toEqual(first.snapshot.sessions.filter((s) => s.state !== 'closed').map((s) => s.id));
    expect(elapsedMs).toBeLessThan(1000);
    first.ws.close();
    second.ws.close();
  });
});
