import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, WorkingStateSections } from '@openfleet/shared';
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
import { loadWorkingStateSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const CUSTOM_MAX_BYTES = 2048;
const CUSTOM_MAX_AGE_MINUTES = 45;
const DEFAULT_MAX_AGE_MINUTES = 30;

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let workingStates: WorkingStateService;
let now: string;

const sections = (overrides: Partial<WorkingStateSections> = {}): WorkingStateSections => ({
  plan: ['ship the API'], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [], ...overrides,
});

// Wired as main.ts wires it: the settings come from config.json and feed both the service and the server.
async function startTestServer(configuredWorkingState: { maxAgeMinutes?: number; maxBytes?: number } = {}) {
  const configPath = join(mkdtempSync(join(tmpdir(), 'of-ws-config-')), 'config.json');
  writeFileSync(configPath, JSON.stringify({ workingState: configuredWorkingState }));
  const settings = loadWorkingStateSettings(configPath);
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  workingStates = new WorkingStateService({ db, clock: () => now, stateRoot: mkdtempSync(join(tmpdir(), 'of-ws-routes-')), maxBytes: settings.maxBytes });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', workingStates, workingStateMaxAgeMinutes: settings.maxAgeMinutes });
}

beforeEach(async () => {
  now = '2026-09-30T10:00:00.000Z';
  await startTestServer();
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const createSession = (overrides: { name?: string; parentId?: string } = {}) => sessions.create({ directory: '/tmp', name: overrides.name ?? 'Dev', harness: 'fake', emoji: '🤖', ...(overrides.parentId ? { parentId: overrides.parentId } : {}) });

async function ticketedWsUrl(): Promise<string> {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  return `${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`;
}

interface Connection { ws: WebSocket; received: ServerEvent[]; snapshot: Required<Extract<ServerEvent, { type: 'snapshot' }>> }

async function connect(): Promise<Connection> {
  const ws = new WebSocket(await ticketedWsUrl());
  const received: ServerEvent[] = [];
  const firstFrame = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve(), { once: true }));
  ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
  await firstFrame;
  const snapshot = received.shift() as Connection['snapshot'];
  return { ws, received, snapshot };
}

// Events reach a client in order: once the marker rename has arrived, everything emitted before it has too.
async function settle(connection: Connection, sessionId: string): Promise<ServerEvent[]> {
  const marker = new Promise<void>((resolve) => connection.ws.addEventListener('message', (message) => { if (JSON.parse(String(message.data)).type === 'session.updated') resolve(); }));
  sessions.rename(sessionId, { name: 'marker' });
  await marker;
  return connection.received.filter((event) => event.type === 'session.working_state');
}

describe('GET /api/sessions/:id/working-state', () => {
  it('shows the working state of a session with its six sections and the daemon time', async () => {
    const session = await createSession();
    workingStates.update(session.id, sections({ plan: ['one'], todo: ['two'], remaining: ['three'], questionsForHuman: ['four?'], internalQuestions: ['five?'], blockers: ['six'] }));

    const response = await api(`/api/sessions/${session.id}/working-state`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: session.id, updatedAt: now,
      plan: ['one'], todo: ['two'], remaining: ['three'], questionsForHuman: ['four?'], internalQuestions: ['five?'], blockers: ['six'],
    });
  });

  it('shows when the fleet of a manager last changed', async () => {
    const manager = await createSession({ name: 'Lead' });
    const child = await createSession({ name: 'Child', parentId: manager.id });
    workingStates.update(manager.id, sections());

    const body = (await (await api(`/api/sessions/${manager.id}/working-state`)).json()) as { fleetChangedAt?: string };

    expect(body.fleetChangedAt).toBe(workingStates.fleetChangedAt(manager.id));
    expect(body.fleetChangedAt).toBeDefined();
    expect(child.parentId).toBe(manager.id);
  });

  it('answers not_found for a session that does not exist', async () => {
    const response = await api('/api/sessions/no-such-session/working-state');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('answers no_state for a session that never wrote its state', async () => {
    const session = await createSession();

    const response = await api(`/api/sessions/${session.id}/working-state`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no_state' });
  });

  it('keeps showing the last state of a closed session', async () => {
    const session = await createSession();
    workingStates.update(session.id, sections({ plan: ['last words'] }));
    await sessions.close(session.id);

    const response = await api(`/api/sessions/${session.id}/working-state`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { plan: string[] }).plan).toEqual(['last words']);
  });

  it('refuses a caller without the admin token', async () => {
    const session = await createSession();
    workingStates.update(session.id, sections());

    const response = await fetch(`${server.url}/api/sessions/${session.id}/working-state`);

    expect(response.status).toBe(401);
  });
});

describe('WS snapshot working states', () => {
  it('carries the states of open sessions only, with the age and size settings in force', async () => {
    const open = await createSession({ name: 'Open' });
    const closed = await createSession({ name: 'Closed' });
    const withoutState = await createSession({ name: 'Blank' });
    workingStates.update(open.id, sections({ plan: ['still here'] }));
    workingStates.update(closed.id, sections({ plan: ['gone'] }));
    await sessions.close(closed.id);

    const { ws, snapshot } = await connect();

    expect(snapshot.workingStates.map((state) => state.sessionId)).toEqual([open.id]);
    expect(snapshot.workingStates[0]).toEqual(workingStates.get(open.id));
    expect(snapshot.workingStates.map((state) => state.sessionId)).not.toContain(withoutState.id);
    expect(snapshot.workingStateMaxAgeMinutes).toBe(DEFAULT_MAX_AGE_MINUTES);
    expect(snapshot.workingStateMaxBytes).toBe(6144);
    ws.close();
  });

  it('carries an empty list rather than omitting the field when no session has a state', async () => {
    await createSession();

    const { ws, snapshot } = await connect();

    expect(snapshot.workingStates).toEqual([]);
    ws.close();
  });

  it('follows the age and size settings the daemon runs with', async () => {
    await server.close();
    await startTestServer({ maxAgeMinutes: CUSTOM_MAX_AGE_MINUTES, maxBytes: CUSTOM_MAX_BYTES });

    const { ws, snapshot } = await connect();

    expect(snapshot.workingStateMaxAgeMinutes).toBe(CUSTOM_MAX_AGE_MINUTES);
    expect(snapshot.workingStateMaxBytes).toBe(CUSTOM_MAX_BYTES);
    ws.close();
  });
});

describe('WS session.working_state', () => {
  it('sends one event per update, with the full state', async () => {
    const session = await createSession();
    const connection = await connect();

    workingStates.update(session.id, sections({ plan: ['first'] }));
    now = '2026-09-30T10:05:00.000Z';
    workingStates.update(session.id, sections({ plan: ['second'] }));
    const events = await settle(connection, session.id);

    expect(events).toEqual([
      { type: 'session.working_state', state: expect.objectContaining({ sessionId: session.id, plan: ['first'], updatedAt: '2026-09-30T10:00:00.000Z' }) },
      { type: 'session.working_state', state: expect.objectContaining({ sessionId: session.id, plan: ['second'], updatedAt: '2026-09-30T10:05:00.000Z' }) },
    ]);
    connection.ws.close();
  });

  it('reaches every connected client', async () => {
    const session = await createSession();
    const first = await connect();
    const second = await connect();

    workingStates.update(session.id, sections());
    const [firstEvents, secondEvents] = [await settle(first, session.id), await settle(second, session.id)];

    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    first.ws.close();
    second.ws.close();
  });

  it('sends the state of a manager again with its new fleetChangedAt when a child is spawned', async () => {
    const manager = await createSession({ name: 'Lead' });
    workingStates.update(manager.id, sections());
    const connection = await connect();

    await createSession({ name: 'Child', parentId: manager.id });
    const events = await settle(connection, manager.id);

    expect(events).toEqual([{ type: 'session.working_state', state: expect.objectContaining({ sessionId: manager.id, fleetChangedAt: workingStates.fleetChangedAt(manager.id) }) }]);
    expect(workingStates.fleetChangedAt(manager.id)).toBeDefined();
    connection.ws.close();
  });

  it('sends the state of a manager again when a child closes, whoever closes it', async () => {
    const manager = await createSession({ name: 'Lead' });
    const child = await createSession({ name: 'Child', parentId: manager.id });
    workingStates.update(manager.id, sections());
    const connection = await connect();

    await sessions.close(child.id);
    const events = await settle(connection, manager.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'session.working_state', state: expect.objectContaining({ sessionId: manager.id }) });
    connection.ws.close();
  });

  it('stays silent when the parent of a spawned child has no state yet', async () => {
    const manager = await createSession({ name: 'Lead' });
    const connection = await connect();

    await createSession({ name: 'Child', parentId: manager.id });
    const events = await settle(connection, manager.id);

    expect(events).toEqual([]);
    connection.ws.close();
  });

  it('stays silent when a session with no parent is spawned or closed', async () => {
    const bystander = await createSession({ name: 'Bystander' });
    workingStates.update(bystander.id, sections());
    const connection = await connect();

    const loner = await createSession({ name: 'Loner' });
    await sessions.close(loner.id);
    const events = await settle(connection, bystander.id);

    expect(events).toEqual([]);
    connection.ws.close();
  });

  it('sends nothing to a client that never got a valid ticket', async () => {
    const session = await createSession();
    const unauthorized = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=forged`);
    const heard: unknown[] = [];
    unauthorized.addEventListener('message', (message) => heard.push(message.data));
    const refused = new Promise<void>((resolve) => unauthorized.addEventListener('error', () => resolve(), { once: true }));
    const authorized = await connect();

    workingStates.update(session.id, sections());
    await settle(authorized, session.id);
    await refused;

    expect(unauthorized.readyState).not.toBe(WebSocket.OPEN);
    expect(heard).toEqual([]);
    authorized.ws.close();
  });

  it('refuses a ticket that was already used once', async () => {
    const url = await ticketedWsUrl();
    const first = new WebSocket(url);
    await new Promise((resolve) => first.addEventListener('open', resolve, { once: true }));
    const replay = new WebSocket(url);
    const replayHeard: unknown[] = [];
    replay.addEventListener('message', (message) => replayHeard.push(message.data));
    await new Promise((resolve) => replay.addEventListener('error', resolve, { once: true }));

    expect(replay.readyState).not.toBe(WebSocket.OPEN);
    expect(replayHeard).toEqual([]);
    first.close();
  });
});
