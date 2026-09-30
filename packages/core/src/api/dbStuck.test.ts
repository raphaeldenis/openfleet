import type { DaemonIssue } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { createDegradedRegistry } from '../process/degradedRegistry.js';
import { watchDatabaseHealth } from '../process/watchDatabaseHealth.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };
const ID_PATTERN = /^[0-9a-f]{8}$/;
const cannotOpenTheDatabase = () => Object.assign(new Error('unable to open database file: /Users/someone/.openfleet/openfleet.db'), { code: 'ERR_SQLITE_ERROR', errcode: 14 });

let server: Awaited<ReturnType<typeof startServer>>;
let failWith: Error | undefined;
let unwatch: () => void;
const openSockets: WebSocket[] = [];

// The daemon's connection stays valid after `chmod 000` of the file (the open descriptor is what sqlite uses), so the
// failure a stuck database produces is injected at the statement level with the error sqlite itself throws.
function failableDatabase(): DatabaseSync {
  const real = openDatabase(':memory:');
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'exec') return (sql: string) => { if (failWith) throw failWith; return target.exec(sql); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  failWith = undefined;
  const db = failableDatabase();
  const degraded = createDegradedRegistry();
  unwatch = watchDatabaseHealth(degraded);
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE,
    modelConfigPath: '/tmp/of-unused/config.json', bus, notes, noteRepo, docs, projects, degraded,
  });
});
afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  unwatch();
  await server.close();
  vi.restoreAllMocks();
});

const saveNote = () => fetch(`${server.url}/api/notes`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ projectId: 'p1', title: 'Plan', bodyMd: 'body' }) });
const health = async () => (await fetch(`${server.url}/health`)).json() as Promise<{ ok: boolean; status: string; issues: number }>;

async function openClient(): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: ADMIN });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'snapshot')).toBe(true));
  return frames;
}

describe('a database that cannot take writes (ERR-06 live case)', () => {
  it('answers a write with db_stuck and a ref, without the sqlite message or a path', async () => {
    failWith = cannotOpenTheDatabase();

    const res = await saveNote();

    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'db_stuck', kind: 'internal', retry: 'later', id: expect.stringMatching(ID_PATTERN) });
    expect(res.headers.get('x-openfleet-error-id')).toBe(body.id);
    expect(JSON.stringify(body)).not.toContain('/Users/someone');
    expect(JSON.stringify(body)).not.toContain('unable to open');
  });

  it('makes /health degraded while it still answers 200 ok: the app probe keeps seeing a daemon that answers', async () => {
    failWith = cannotOpenTheDatabase();
    await saveNote();

    const res = await fetch(`${server.url}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'degraded', issues: 1 });
  });

  it('puts the db_stuck issue in a fresh snapshot, with the log line of the same ref', async () => {
    failWith = cannotOpenTheDatabase();
    await saveNote();

    const frames = await openClient();

    const snapshot = frames.find((frame) => frame.type === 'snapshot') as { daemonIssues: DaemonIssue[] };
    expect(snapshot.daemonIssues).toMatchObject([{ code: 'db_stuck', id: expect.stringMatching(ID_PATTERN) }]);
    const logged = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.includes(snapshot.daemonIssues[0]!.id))).toBe(true);
  });

  it('broadcasts daemon.issues when the db gets stuck, and again, empty, when a write succeeds', async () => {
    const frames = await openClient();

    failWith = cannotOpenTheDatabase();
    await saveNote();
    failWith = undefined;
    expect((await saveNote()).status).toBe(201);

    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'daemon.issues')).toHaveLength(2));
    const lists = (frames.filter((frame) => frame.type === 'daemon.issues') as { issues: DaemonIssue[] }[]).map(({ issues }) => issues.map((issue) => issue.code));
    expect(lists).toEqual([['db_stuck'], []]);
  });

  it('clears on the first write that succeeds, and /health goes back to ok', async () => {
    failWith = cannotOpenTheDatabase();
    await saveNote();
    expect(await health()).toMatchObject({ ok: true, status: 'degraded' });

    failWith = undefined;
    const recovered = await saveNote();

    expect(recovered.status).toBe(201);
    expect(await health()).toEqual(expect.objectContaining({ ok: true, status: 'ok', issues: 0 }));
  });

  it('counts a repeated failure on one issue instead of growing the list', async () => {
    failWith = cannotOpenTheDatabase();
    for (let attempt = 0; attempt < 5; attempt += 1) await saveNote();

    expect(await health()).toMatchObject({ status: 'degraded', issues: 1 });
  });

  it('does not mark a caller error as a stuck database', async () => {
    const res = await fetch(`${server.url}/api/notes`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ projectId: 'missing', title: 'Plan', bodyMd: 'body' }) });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await health()).toMatchObject({ status: 'ok' });
  });
});
