import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { HandoffContent, HandoffPreview, HandoffTarget, NoteSummary, Session } from '@openfleet/shared';
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
let handoffClock: string;

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
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects, git, settings: { writeOnClose: configWriteOnClose }, clock: () => handoffClock });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json',
    handoff,
  });
}

beforeEach(async () => {
  docsFolder = mkdtempSync(join(tmpdir(), 'of-handoff-docs-'));
  configWriteOnClose = true;
  handoffClock = CLOCK;
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

const SECTIONS: HandoffContent = {
  goal: 'Ship the handoff save',
  state: 'Route written, tests green',
  decisions: 'Keep the guard in memory',
  filesTouched: 'handoffRoutes.ts',
  nextSteps: 'Wire the desktop panel',
  openQuestions: 'None',
};
const IDENTICAL_BODY_WINDOW_MS = 60_000;

const saveHandoff = (sessionId: string, body: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${server.url}/api/sessions/${sessionId}/handoff`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const handoffFiles = () => readdirSync(join(docsFolder, 'handoffs'));
const afterMs = (ms: number) => new Date(Date.parse(CLOCK) + ms).toISOString();

describe('POST /api/sessions/:id/handoff', () => {
  it('writes the handoff file in the docs folder and answers 201 with the note and its relative path', async () => {
    const session = await sessionWithDocsFolder();

    const res = await saveHandoff(session.id, SECTIONS);
    const saved = (await res.json()) as { note: NoteSummary; relativePath: string };

    expect(res.status).toBe(201);
    expect(saved.relativePath).toBe('handoffs/2026-10-04-gimli.md');
    expect(saved.note).toMatchObject({ title: 'Gimli', folder: 'handoffs', fileBacked: true });
    const fileText = readFileSync(join(docsFolder, saved.relativePath), 'utf8');
    expect(fileText).toContain('## Goal\nShip the handoff save');
    expect(fileText).toContain('## Open questions\nNone');
  });

  it('stores the handoff as a file-backed note of the handoffs folder', async () => {
    const session = await sessionWithDocsFolder();
    const { note } = (await (await saveHandoff(session.id, SECTIONS)).json()) as { note: NoteSummary };

    const row = db.prepare('SELECT folder, project_id, file_path FROM notes WHERE id = ?').get(note.id) as { folder: string; project_id: string; file_path: string };

    expect(row).toMatchObject({ folder: 'handoffs', project_id: 'p-docs' });
    expect(row.file_path.endsWith('/handoffs/2026-10-04-gimli.md')).toBe(true);
  });

  it('gives a second save with a different body its own file', async () => {
    const session = await sessionWithDocsFolder();
    await saveHandoff(session.id, SECTIONS);

    const res = await saveHandoff(session.id, { ...SECTIONS, goal: 'A different goal' });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { relativePath: string }).relativePath).toBe('handoffs/2026-10-04-gimli-2.md');
    expect(handoffFiles()).toHaveLength(2);
  });

  describe('identical body guard', () => {
    it('answers an identical body within the window with 200 and the first note, without a new file or note row', async () => {
      const session = await sessionWithDocsFolder();
      const first = (await (await saveHandoff(session.id, SECTIONS)).json()) as { note: NoteSummary; relativePath: string };
      const notesAfterFirst = noteCount();
      handoffClock = afterMs(IDENTICAL_BODY_WINDOW_MS - 1_000);

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(first);
      expect(handoffFiles()).toHaveLength(1);
      expect(noteCount()).toBe(notesAfterFirst);
    });

    it('writes a new file once the window has passed', async () => {
      const session = await sessionWithDocsFolder();
      await saveHandoff(session.id, SECTIONS);
      handoffClock = afterMs(IDENTICAL_BODY_WINDOW_MS + 1_000);

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(201);
      expect(handoffFiles()).toHaveLength(2);
    });

    it('does not apply to a body that differs in a single section', async () => {
      const session = await sessionWithDocsFolder();
      await saveHandoff(session.id, SECTIONS);

      const res = await saveHandoff(session.id, { ...SECTIONS, openQuestions: 'One more question' });

      expect(res.status).toBe(201);
    });

    it('does not apply across sessions', async () => {
      const first = await sessionWithDocsFolder('Gimli');
      const second = await createSession('Legolas');
      attachProject(second.id, 'p-docs');
      await saveHandoff(first.id, SECTIONS);

      const res = await saveHandoff(second.id, SECTIONS);

      expect(res.status).toBe(201);
      expect(handoffFiles()).toHaveLength(2);
    });

    it('treats two bodies that differ only by a masked secret as identical', async () => {
      const session = await sessionWithDocsFolder();
      await saveHandoff(session.id, { ...SECTIONS, state: `token ${SECRET}` });

      const res = await saveHandoff(session.id, { ...SECTIONS, state: `token ${SECRET}` });

      expect(res.status).toBe(200);
    });
  });

  it('masks a secret in the file and in the response', async () => {
    const session = await sessionWithDocsFolder();

    const res = await saveHandoff(session.id, { ...SECTIONS, state: `call the API with ${SECRET}` });
    const responseText = await res.text();

    expect(responseText).not.toContain(SECRET);
    const savedFiles = handoffFiles().map((name) => readFileSync(join(docsFolder, 'handoffs', name), 'utf8'));
    expect(savedFiles.join('')).not.toContain(SECRET);
    expect(savedFiles.join('')).toContain('call the API with');
  });

  it('keeps the file inside the handoffs folder whatever the session name contains', async () => {
    makeProject('p-docs', docsFolder);
    docs.ensureLayout(docsFolder);
    const session = await createSession('../../escape/..\\attempt');
    attachProject(session.id, 'p-docs');
    const docsFolderEntriesBefore = readdirSync(docsFolder).sort();

    const res = await saveHandoff(session.id, SECTIONS);
    const { relativePath } = (await res.json()) as { relativePath: string };

    expect(res.status).toBe(201);
    expect(relativePath).toMatch(/^handoffs\/[a-z0-9-]+\.md$/);
    expect(handoffFiles()).toHaveLength(1);
    expect(readdirSync(docsFolder).sort()).toEqual(docsFolderEntriesBefore);
    expect(readdirSync(dirname(docsFolder)).filter((entry) => entry.startsWith('escape'))).toEqual([]);
  });

  describe('path safety', () => {
    it('refuses a handoffs folder that is a symlink leaving the docs folder, and writes nothing outside', async () => {
      makeProject('p-escape', docsFolder);
      const outside = mkdtempSync(join(tmpdir(), 'of-outside-'));
      symlinkSync(outside, join(docsFolder, 'handoffs'));
      const session = await createSession();
      attachProject(session.id, 'p-escape');
      const notesBefore = noteCount();

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'path_escapes_docs_folder', kind: 'conflict', retry: 'never' });
      expect(readdirSync(outside)).toEqual([]);
      expect(noteCount()).toBe(notesBefore);
    });

    it('does not leak the path in the error', async () => {
      makeProject('p-escape', docsFolder);
      symlinkSync(mkdtempSync(join(tmpdir(), 'of-outside-')), join(docsFolder, 'handoffs'));
      const session = await createSession();
      attachProject(session.id, 'p-escape');

      const text = await (await saveHandoff(session.id, SECTIONS)).text();

      expect(text).not.toContain(docsFolder);
    });
  });

  describe('docs folder failures', () => {
    it.skipIf(isRoot)('maps a read-only handoffs folder to docs_folder_not_writable and writes nothing', async () => {
      const session = await sessionWithDocsFolder();
      const notesBefore = noteCount();
      chmodSync(join(docsFolder, 'handoffs'), 0o555);

      try {
        const res = await saveHandoff(session.id, SECTIONS);

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: 'docs_folder_not_writable', kind: 'conflict', retry: 'later' });
        expect(noteCount()).toBe(notesBefore);
        expect(handoffFiles()).toEqual([]);
      } finally {
        chmodSync(join(docsFolder, 'handoffs'), 0o755);
      }
    });

    it.skipIf(isRoot)('saves the same body once the folder is writable again, a failed save is not remembered by the guard', async () => {
      const session = await sessionWithDocsFolder();
      chmodSync(join(docsFolder, 'handoffs'), 0o555);
      try {
        await saveHandoff(session.id, SECTIONS);
      } finally {
        chmodSync(join(docsFolder, 'handoffs'), 0o755);
      }

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(201);
    });

    it('maps a docs folder deleted since it was configured to file_unreadable', async () => {
      const session = await sessionWithDocsFolder();
      rmSync(docsFolder, { recursive: true });

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'file_unreadable', kind: 'conflict', retry: 'later' });
    });

    it('maps a missing handoffs subfolder to file_unreadable', async () => {
      const session = await sessionWithDocsFolder();
      rmSync(join(docsFolder, 'handoffs'), { recursive: true });

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'file_unreadable' });
    });
  });

  describe('refusals', () => {
    it('answers no_docs_folder for a session without a project', async () => {
      const session = await createSession();

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'no_docs_folder', kind: 'conflict', retry: 'never' });
    });

    it('answers no_docs_folder for a project without a docs folder', async () => {
      makeProject('p-bare', null);
      const session = await createSession();
      attachProject(session.id, 'p-bare');

      const res = await saveHandoff(session.id, SECTIONS);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'no_docs_folder' });
    });

    it('answers session_not_found for an unknown session', async () => {
      const res = await saveHandoff('nope', SECTIONS);

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'session_not_found' });
    });

    it.each([
      ['an unknown key', { ...SECTIONS, path: '../../etc/passwd' }],
      ['a missing section', { goal: 'only a goal' }],
      ['a non-string section', { ...SECTIONS, goal: 42 }],
      ['a section over 20 000 characters', { ...SECTIONS, goal: 'x'.repeat(20_001) }],
      ['no body', undefined],
    ])('answers invalid_body for %s and writes nothing', async (_label, body) => {
      const session = await sessionWithDocsFolder();

      const res = await saveHandoff(session.id, body);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_body' });
      expect(handoffFiles()).toEqual([]);
    });

    it('refuses a request without the admin token', async () => {
      const session = await sessionWithDocsFolder();

      const res = await saveHandoff(session.id, SECTIONS, {});

      expect(res.status).toBe(401);
      expect(handoffFiles()).toEqual([]);
    });
  });
});

describe('the preview reads git, the target does not', () => {
  it('asks git for the preview of a session', async () => {
    const session = await createSession();

    await previewOf(session.id);

    expect(git.statusShort).toHaveBeenCalledWith('/tmp');
  });
});
