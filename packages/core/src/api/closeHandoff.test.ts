import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Session } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import type { GitPort } from '../notes/gitPort.js';
import { registerHandoffOnClose } from '../notes/handoffService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { TodoTracker } from '../todos/todoTracker.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createHandoffRouteDeps } from './handoffRoutes.js';
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };
const CLOCK = '2026-10-04T10:00:00.000Z';
const CRASH_EXIT_CODE = 1;
const isRoot = process.getuid?.() === 0;

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let projects: ProjectRepository;
let docs: DocsFolderService;
let docsFolder: string;
let writeOnCloseSetting: boolean;
let unsubscribeHandoffOnClose: () => unknown;

const post = (path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });
const closeSession = (sessionId: string, body?: unknown) => post(`/api/sessions/${sessionId}/close`, body);
const handoffFiles = () => (existsSync(join(docsFolder, 'handoffs')) ? readdirSync(join(docsFolder, 'handoffs')) : []);
const attachProject = (sessionId: string, projectId: string) => db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId);
const sessionWithDocsFolder = async (name = 'Gimli'): Promise<Session> => {
  projects.insert({ id: 'p-docs', name: 'p-docs', docsFolderPath: docsFolder, createdAt: 't0' });
  docs.ensureLayout(docsFolder);
  const session = await sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '⛏️' });
  attachProject(session.id, 'p-docs');
  return session;
};
const crash = (sessionId: string) => (sessions.harnessHandle(sessionId) as FakeHandle).emitExit(CRASH_EXIT_CODE);

async function boot(): Promise<void> {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const workingStates = new WorkingStateService({ db, clock: () => CLOCK, stateRoot: mkdtempSync(join(tmpdir(), 'of-ws-')), maxBytes: 6144 });
  const todos = new TodoTracker({ sessions, bus });
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const git: GitPort = { statusShort: vi.fn(() => ' M src/app.ts'), diffStatOf: vi.fn(() => ' 1 file changed') };
  const settings = { writeOnClose: writeOnCloseSetting };
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects, git, settings, clock: () => CLOCK });
  unsubscribeHandoffOnClose = registerHandoffOnClose(bus, handoff.handoffs, { writeOnClose: settings.writeOnClose });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json',
    handoff,
  });
}

beforeEach(async () => {
  docsFolder = mkdtempSync(join(tmpdir(), 'of-close-handoff-docs-'));
  writeOnCloseSetting = true;
  await boot();
});
afterEach(async () => {
  unsubscribeHandoffOnClose();
  await server.close();
  rmSync(docsFolder, { recursive: true, force: true });
});

describe('POST /api/sessions/:id/close with writeHandoff', () => {
  it('writes the handoff, closes the session and answers the written path', async () => {
    const session = await sessionWithDocsFolder();

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handoff: { status: 'written', relativePath: 'handoffs/2026-10-04-gimli.md' } });
    expect(handoffFiles()).toEqual(['2026-10-04-gimli.md']);
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['writeHandoff false', { writeHandoff: false }],
  ])('writes nothing and answers no handoff with %s', async (_label, body) => {
    const session = await sessionWithDocsFolder();

    const res = await closeSession(session.id, body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(handoffFiles()).toEqual([]);
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('refuses an unknown key in the body and keeps the session open', async () => {
    const session = await sessionWithDocsFolder();

    const res = await closeSession(session.id, { writeHandoff: true, path: '../x' });

    expect(res.status).toBe(400);
    expect(sessions.get(session.id)?.state).not.toBe('closed');
  });

  it('closes and skips the handoff when the session has no docs folder', async () => {
    const session = await sessions.create({ directory: '/tmp', name: 'Loose', harness: 'fake', emoji: '⛏️' });

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(await res.json()).toEqual({ handoff: { status: 'skipped', reason: 'target_unavailable' } });
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('skips the handoff when one was saved by hand a moment ago', async () => {
    const session = await sessionWithDocsFolder();
    const sections = { goal: 'g', state: 's', decisions: 'd', filesTouched: 'f', nextSteps: 'n', openQuestions: 'q' };
    await post(`/api/sessions/${session.id}/handoff`, sections);

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(await res.json()).toEqual({ handoff: { status: 'skipped', reason: 'recent_manual_handoff' } });
    expect(handoffFiles()).toHaveLength(1);
  });

  it.skipIf(isRoot)('still closes the session when the handoff cannot be written, and says why', async () => {
    const session = await sessionWithDocsFolder();
    chmodSync(join(docsFolder, 'handoffs'), 0o500);

    const res = await closeSession(session.id, { writeHandoff: true });
    chmodSync(join(docsFolder, 'handoffs'), 0o700);

    const { handoff } = (await res.json()) as { handoff: { status: string; error: string; message: string } };
    expect(res.status).toBe(200);
    expect(handoff).toMatchObject({ status: 'failed', error: 'docs_folder_not_writable' });
    expect(handoff.message).toContain('not writable');
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('answers 404 for an unknown session', async () => {
    const res = await closeSession('nope', { writeHandoff: true });

    expect(res.status).toBe(404);
  });
});

describe('the automatic handoff on close', () => {
  it('writes one handoff when the agent process crashes', async () => {
    const session = await sessionWithDocsFolder();

    crash(session.id);

    expect(handoffFiles()).toEqual(['2026-10-04-gimli.md']);
  });

  it('writes nothing when the user closes without asking for a handoff', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id);

    expect(handoffFiles()).toEqual([]);
  });

  it('writes nothing when the user closes with the box unchecked', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id, { writeHandoff: false });

    expect(handoffFiles()).toEqual([]);
  });

  it('writes nothing on a daemon shutdown', async () => {
    await sessionWithDocsFolder();

    await sessions.closeAll();

    expect(handoffFiles()).toEqual([]);
  });

  it('writes a single handoff when the user asks for one, and the close event adds none', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id, { writeHandoff: true });

    expect(handoffFiles()).toHaveLength(1);
  });

  it('writes nothing on a crash when the setting is off', async () => {
    unsubscribeHandoffOnClose();
    await server.close();
    writeOnCloseSetting = false;
    docsFolder = mkdtempSync(join(tmpdir(), 'of-close-handoff-docs-'));
    await boot();
    const session = await sessionWithDocsFolder();

    crash(session.id);

    expect(handoffFiles()).toEqual([]);
  });
});
