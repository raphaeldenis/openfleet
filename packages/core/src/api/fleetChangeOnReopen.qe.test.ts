import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import type { WorkingStateSections } from '@openfleet/shared';
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
import { SessionStartContext } from '../workingState/sessionStartContext.js';
import { StopRefusal } from '../workingState/stopRefusal.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import type { WorkingStateSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const STATE: WorkingStateSections = { plan: ['ship'], todo: ['write tests'], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] };
const TICK_MS = 5;

let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let workingStates: WorkingStateService;
let managerId: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const settings: WorkingStateSettings = { maxBytes: 8192, enforce: true, maxAgeMinutes: 30 };
  const clock = () => new Date().toISOString();
  workingStates = new WorkingStateService({ db, clock, stateRoot: mkdtempSync(join(tmpdir(), 'of-reopen-qe-')), maxBytes: settings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings, clock });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings, clock });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', workingStates, stopRefusal, sessionStartContext });
  managerId = (await sessions.create({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' })).id;
});
afterEach(() => server.close());

const tick = () => new Promise((resolve) => setTimeout(resolve, TICK_MS));
const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const stopOf = async (sessionId: string) => (await fetch(`${server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'Stop' }) })).json() as Promise<{ decision?: string; reason?: string }>;
const spawnChild = (name: string, parentId = managerId) => sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🧒', parentId });
const reopen = (id: string) => api(`/api/sessions/${id}/reopen`, { method: 'POST' });

describe('QE probes: reopen as a fleet change', () => {
  it('lets a manager satisfy the refusal after a FAILED reopen by updating its state (no infinite refusal loop)', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    await tick();
    workingStates.update(managerId, STATE);
    await tick();
    class FailingHarness implements Harness {
      readonly id = 'fake' as const;
      start(_launch: HarnessLaunch): HarnessHandle { throw new Error('pty spawn ENOENT'); }
    }
    (sessions as unknown as { harnessFor: (id: string) => Harness }).harnessFor = () => new FailingHarness();
    await reopen(child.id);

    const refusedWhileStale = await stopOf(managerId);
    await tick();
    workingStates.update(managerId, STATE);
    const acceptedAfterUpdate = await stopOf(managerId);

    expect(refusedWhileStale.decision).toBe('block');
    expect(acceptedAfterUpdate).toEqual({});
  });

  it('names at most 10 fleet changes and counts the rest with reopened and closed kinds mixed', async () => {
    const children = [];
    for (let i = 0; i < 7; i++) children.push(await spawnChild(`K${i}`));
    await tick();
    workingStates.update(managerId, STATE);
    await tick();
    for (const child of children) { await sessions.close(child.id); await tick(); await reopen(child.id); await tick(); }

    const refused = await stopOf(managerId);

    expect(refused.reason).toContain('and 4 more');
    expect(refused.reason!.match(/\((closed|reopened)\)/g)).toHaveLength(10);
    expect(refused.reason).toContain('(reopened)');
    expect(refused.reason).toContain('(closed)');
  });

  it('names only the changes made after the state was written, not older spawns and closes', async () => {
    const early = await spawnChild('Early');
    await tick();
    await sessions.close(early.id);
    await tick();
    workingStates.update(managerId, STATE);
    await tick();
    const late = await spawnChild('Late');

    const refused = await stopOf(managerId);

    expect(late.id).toBeDefined();
    expect(refused.reason).toContain('Late (spawned)');
    expect(refused.reason).not.toContain('Early');
  });

  it('carries the reopen time in fleetChangedAt of a fresh WS snapshot for a live manager', async () => {
    const child = await spawnChild('Builder-3');
    await tick();
    await sessions.close(child.id);
    workingStates.update(managerId, STATE);
    await tick();
    const beforeReopen = new Date().toISOString();
    await reopen(child.id);
    const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const snapshot = await new Promise<{ workingStates: { sessionId: string; fleetChangedAt?: string }[] }>((resolve) => ws.addEventListener('message', (message) => resolve(JSON.parse(String(message.data))), { once: true }));
    ws.close();

    const managerState = snapshot.workingStates.find((state) => state.sessionId === managerId);

    expect(managerState?.fleetChangedAt).toBeDefined();
    expect(managerState!.fleetChangedAt! >= beforeReopen).toBe(true);
  });

  it('orders equal timestamps deterministically by name', () => {
    const at = '2030-01-01T00:00:00.000Z';
    db.prepare("UPDATE sessions SET created_at = ? WHERE parent_id = ?").run(at, managerId);
    const parent = managerId;
    for (const name of ['b', 'a']) {
      const id = `id-${name}`;
      db.prepare("INSERT INTO sessions (id, name, directory, harness, state, created_at, parent_id, emoji, hook_token, mcp_token, model, state_since) SELECT ?, ?, directory, harness, 'closed', ?, ?, emoji, ?, ?, model, state_since FROM sessions WHERE id = ?")
        .run(id, name, at, parent, `h-${name}`, `m-${name}`, parent);
      db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES (?, 'reopened', ?)").run(id, at);
    }

    const changes = workingStates.fleetChanges(parent);

    expect(changes.map((change) => change.name)).toEqual(['a', 'a', 'b', 'b']);
    expect(changes.map((change) => change.kind).sort()).toEqual(['reopened', 'reopened', 'spawned', 'spawned']);
  });

  it('PROBE plan and cost of fleetChanges with 10k session_events rows and 200 children', () => {
    const insertSession = db.prepare("INSERT INTO sessions (id, name, directory, harness, state, created_at, parent_id, emoji, hook_token, mcp_token, model, state_since) SELECT ?, ?, directory, harness, 'idle', ?, ?, emoji, ?, ?, model, state_since FROM sessions WHERE id = ?");
    const insertEvent = db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES (?, 'reopened', ?)");
    for (let i = 0; i < 200; i++) insertSession.run(`kid-${i}`, `kid${i}`, '2030-01-01T00:00:00.000Z', managerId, `h${i}`, `m${i}`, managerId);
    for (let i = 0; i < 10_000; i++) insertEvent.run(`kid-${i % 200}`, `2030-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT sessions.name, 'reopened' AS kind, session_events.ts AS changedAt FROM session_events
        JOIN sessions ON sessions.id = session_events.session_id
        WHERE sessions.parent_id = ? AND session_events.kind = 'reopened'`).all(managerId) as { detail: string }[];

    const started = performance.now();
    const changes = workingStates.fleetChanges(managerId);
    const elapsedMs = performance.now() - started;

    // eslint-disable-next-line no-console
    console.log('QE-PLAN', JSON.stringify(plan.map((row) => row.detail)), 'rows', changes.length, 'ms', elapsedMs.toFixed(1));
    expect(changes.length).toBeGreaterThan(10_000);
  });

  it('PROBE deleting a session that has a reopen row is refused by the foreign key (no cascade)', async () => {
    const child = await spawnChild('Builder-3');
    await sessions.close(child.id);
    await reopen(child.id);

    const deleteChild = () => db.prepare('DELETE FROM sessions WHERE id = ?').run(child.id);

    expect(deleteChild).toThrow(/FOREIGN KEY/);
  });
});
