import { chmodSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { HandoffPreview, HandoffTarget, Session } from '@openfleet/shared';
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
import type { GitPort } from '../notes/gitPort.js';
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

const ADMIN = { authorization: 'Bearer admin' };
const CLOCK = '2026-10-04T10:00:00.000Z';
const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const isRoot = process.getuid?.() === 0;

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let managers: ManagerService;
let workingStates: WorkingStateService;
let projects: ProjectRepository;
let docs: DocsFolderService;
let git: { statusShort: ReturnType<typeof vi.fn<GitPort['statusShort']>>; diffStatOf: ReturnType<typeof vi.fn<GitPort['diffStatOf']>> };
let docsFolder: string;
let configWriteOnClose: boolean;

const get = (path: string, headers: Record<string, string> = ADMIN) => fetch(`${server.url}${path}`, { headers });
const getJson = async <T>(path: string) => (await get(path)).json() as Promise<T>;
const previewOf = (sessionId: string) => getJson<HandoffPreview>(`/api/sessions/${sessionId}/handoff-preview`);
const targetOf = (sessionId: string) => getJson<HandoffTarget>(`/api/sessions/${sessionId}/handoff-target`);
const noteCount = () => (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n;
const createSession = (name = 'Gimli') => sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '⛏️' });
const attachProject = (sessionId: string, projectId: string) => db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId);
const makeProject = (id: string, docsFolderPath: string | null) => projects.insert({ id, name: id, docsFolderPath, createdAt: 't0' });
const sessionWithDocsFolder = async (name = 'Gimli'): Promise<Session> => {
  makeProject('p-docs', docsFolder);
  docs.ensureLayout(docsFolder);
  const session = await createSession(name);
  attachProject(session.id, 'p-docs');
  return session;
};

async function boot(): Promise<void> {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  workingStates = new WorkingStateService({ db, clock: () => CLOCK, stateRoot: mkdtempSync(join(tmpdir(), 'of-ws-')), maxBytes: 6144 });
  const todos = new TodoTracker({ sessions, bus });
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  git = { statusShort: vi.fn(() => ' M src/app.ts'), diffStatOf: vi.fn(() => ' 1 file changed') };
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects, git, settings: { writeOnClose: configWriteOnClose }, clock: () => CLOCK });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json',
    handoff,
  });
}

beforeEach(async () => {
  docsFolder = mkdtempSync(join(tmpdir(), 'of-handoff-docs-'));
  configWriteOnClose = true;
  await boot();
});
afterEach(() => server.close());

describe('GET /api/sessions/:id/handoff-preview', () => {
  it('previews an open session: kind, sections from the working state, sources, target and generation time', async () => {
    const session = await createSession();
    workingStates.update(session.id, { plan: ['Ship the handoff preview'], todo: ['write the tests'], remaining: [], questionsForHuman: ['which folder?'], internalQuestions: [], blockers: [] });

    const res = await get(`/api/sessions/${session.id}/handoff-preview`);
    const preview = (await res.json()) as HandoffPreview;

    expect(res.status).toBe(200);
    expect(preview).toMatchObject({
      sessionId: session.id,
      kind: 'session',
      generatedAt: CLOCK,
      truncated: [],
      sections: { goal: 'Ship the handoff preview', nextSteps: '- write the tests', openQuestions: '- which folder?', decisions: '' },
      sources: { goal: 'working_state', state: 'session', decisions: 'none', filesTouched: 'git', nextSteps: 'working_state', openQuestions: 'working_state' },
      target: { available: false, reason: 'no_project', writeOnCloseDefault: false },
    });
    expect(preview.sections.state).toContain('Session state:');
    expect(preview.sections.filesTouched).toContain('M src/app.ts');
  });

  it('previews a closed session', async () => {
    const session = await createSession();
    await fetch(`${server.url}/api/sessions/${session.id}/close`, { method: 'POST', headers: ADMIN });

    const res = await get(`/api/sessions/${session.id}/handoff-preview`);
    const preview = (await res.json()) as HandoffPreview;

    expect(res.status).toBe(200);
    expect(preview.kind).toBe('session');
    expect(preview.sections.state).toContain('Session state: closed');
  });

  it('previews a manager with the mission as goal', async () => {
    const manager = await managers.createManagerSession({ directory: '/tmp', name: 'Boss', emoji: '🧭', harness: 'fake', manager: { mission: 'Keep the fleet shipping', childrenCap: 3 } });

    const preview = await previewOf(manager.id);

    expect(preview.kind).toBe('manager');
    expect(preview.sections.goal).toBe('Keep the fleet shipping');
    expect(preview.sources.goal).toBe('manager');
  });

  it('answers an unknown session with the session_not_found envelope', async () => {
    const res = await get('/api/sessions/nope/handoff-preview');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'session_not_found', kind: 'not_found', retry: 'never' });
  });

  it('answers 200 with an unavailable target when the project has no docs folder', async () => {
    makeProject('p-bare', null);
    const session = await createSession();
    attachProject(session.id, 'p-bare');

    const res = await get(`/api/sessions/${session.id}/handoff-preview`);
    const preview = (await res.json()) as HandoffPreview;

    expect(res.status).toBe(200);
    expect(preview.target).toEqual({ available: false, reason: 'no_docs_folder', writeOnCloseDefault: false });
  });

  it('answers an available target with the path it would get when the project has a docs folder', async () => {
    const session = await sessionWithDocsFolder();

    const preview = await previewOf(session.id);

    expect(preview.target).toEqual({ available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: true });
  });

  it('writes no file and no note row', async () => {
    const session = await sessionWithDocsFolder();
    const filesBefore = readdirSync(join(docsFolder, 'handoffs'));
    const notesBefore = noteCount();

    await previewOf(session.id);
    await previewOf(session.id);

    expect(readdirSync(join(docsFolder, 'handoffs'))).toEqual(filesBefore);
    expect(noteCount()).toBe(notesBefore);
  });

  it('masks a secret held in the working state', async () => {
    const session = await createSession();
    workingStates.update(session.id, { plan: [`call the API with ${SECRET}`], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] });

    const res = await get(`/api/sessions/${session.id}/handoff-preview`);
    const text = await res.text();

    expect(text).not.toContain(SECRET);
    expect(text).toContain('call the API with');
  });

  it('refuses a request without the admin token', async () => {
    const session = await createSession();

    const res = await get(`/api/sessions/${session.id}/handoff-preview`, {});

    expect(res.status).toBe(401);
  });
});

describe('GET /api/sessions/:id/handoff-target', () => {
  it('answers no_project for a real session, because nothing links a session to a project yet', async () => {
    const session = await createSession();

    const res = await get(`/api/sessions/${session.id}/handoff-target`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'no_project', writeOnCloseDefault: false });
  });

  it('answers no_docs_folder for a project without a docs folder', async () => {
    makeProject('p-bare', null);
    const session = await createSession();
    attachProject(session.id, 'p-bare');

    expect(await targetOf(session.id)).toEqual({ available: false, reason: 'no_docs_folder', writeOnCloseDefault: false });
  });

  it('answers the path the handoff would get, with writeOnCloseDefault on', async () => {
    const session = await sessionWithDocsFolder();

    expect(await targetOf(session.id)).toEqual({ available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: true });
  });

  it('includes the collision suffix of a name already taken', async () => {
    const session = await sessionWithDocsFolder();
    writeFileSync(join(docsFolder, 'handoffs', '2026-10-04-gimli.md'), 'taken');

    expect((await targetOf(session.id)).relativePath).toBe('handoffs/2026-10-04-gimli-2.md');
  });

  it('answers writeOnCloseDefault false when the setting is off, even for a usable folder', async () => {
    await server.close();
    configWriteOnClose = false;
    await boot();
    const session = await sessionWithDocsFolder();

    expect(await targetOf(session.id)).toEqual({ available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: false });
  });

  it('answers docs_folder_unusable when the configured folder is gone', async () => {
    makeProject('p-gone', join(docsFolder, 'gone'));
    const session = await createSession();
    attachProject(session.id, 'p-gone');

    expect(await targetOf(session.id)).toEqual({ available: false, reason: 'docs_folder_unusable', writeOnCloseDefault: false });
  });

  it('answers docs_folder_unusable when handoffs is a symlink leaving the docs folder', async () => {
    makeProject('p-escape', docsFolder);
    symlinkSync(mkdtempSync(join(tmpdir(), 'of-outside-')), join(docsFolder, 'handoffs'));
    const session = await createSession();
    attachProject(session.id, 'p-escape');

    expect((await targetOf(session.id)).reason).toBe('docs_folder_unusable');
  });

  it.skipIf(isRoot)('answers docs_folder_unusable when the handoffs folder is read-only', async () => {
    const session = await sessionWithDocsFolder();
    chmodSync(join(docsFolder, 'handoffs'), 0o555);

    try {
      expect(await targetOf(session.id)).toEqual({ available: false, reason: 'docs_folder_unusable', writeOnCloseDefault: false });
    } finally {
      chmodSync(join(docsFolder, 'handoffs'), 0o755);
    }
  });

  it('never reads git nor the working state', async () => {
    const session = await sessionWithDocsFolder();
    const readWorkingState = vi.spyOn(workingStates, 'get');

    await targetOf(session.id);

    expect(git.statusShort).not.toHaveBeenCalled();
    expect(git.diffStatOf).not.toHaveBeenCalled();
    expect(readWorkingState).not.toHaveBeenCalled();
  });

  it('writes no file and no note row', async () => {
    const session = await sessionWithDocsFolder();
    const filesBefore = readdirSync(join(docsFolder, 'handoffs'));
    const notesBefore = noteCount();

    await targetOf(session.id);

    expect(readdirSync(join(docsFolder, 'handoffs'))).toEqual(filesBefore);
    expect(noteCount()).toBe(notesBefore);
  });

  it('answers an unknown session with the session_not_found envelope', async () => {
    const res = await get('/api/sessions/nope/handoff-target');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'session_not_found' });
  });

  it('refuses a request without the admin token', async () => {
    const session = await createSession();

    const res = await get(`/api/sessions/${session.id}/handoff-target`, {});

    expect(res.status).toBe(401);
  });
});

describe('the preview reads git, the target does not', () => {
  it('asks git for the preview of a session', async () => {
    const session = await createSession();

    await previewOf(session.id);

    expect(git.statusShort).toHaveBeenCalledWith('/tmp');
  });
});
