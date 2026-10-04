import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ErrorEnvelope, HandoffTarget, Page, Project, Session } from '@openfleet/shared';
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
import { ProjectRepository } from '../projects/projectRepository.js';
import { ProjectService } from '../projects/projectService.js';
import { SessionService } from '../sessions/sessionService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { TodoTracker } from '../todos/todoTracker.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createHandoffRouteDeps } from './handoffRoutes.js';
import { startServer } from './server.js';

const CLOCK = '2026-10-04T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const isRoot = process.getuid?.() === 0;
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let onDocsFolderSet: ReturnType<typeof vi.fn<(projectId: string) => void>>;

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN_TOKEN}` }) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const createProject = (body: unknown) => call('POST', '/api/projects', body);
const patchProject = (id: string, body: unknown) => call('PATCH', `/api/projects/${id}`, body);
const createSession = (body: Record<string, unknown>) => call('POST', '/api/sessions', { directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️', ...body });
const listProjects = async () => ((await (await call('GET', '/api/projects')).json()) as Page<Project>).items;
const projectRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
const noteRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n;
const aFolder = () => tempDirs.make('of-link-docs-');
const layoutOf = (folder: string) => readdirSync(folder).sort();
const LAYOUT = ['handoffs', 'plans', 'reports', 'specs'];

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(tempDirs.make('of-link-wt-'), 'wt'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const workingStates = new WorkingStateService({ db, clock: () => CLOCK, stateRoot: tempDirs.make('of-link-ws-'), maxBytes: 6144 });
  const todos = new TodoTracker({ sessions, bus });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  onDocsFolderSet = vi.fn();
  const projectService = new ProjectService({ projects, docs, clock: () => CLOCK, newId, onDocsFolderSet });
  const git = { statusShort: () => '', diffStatOf: () => '' };
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects, git, settings: { writeOnClose: true }, clock: () => CLOCK });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService, handoff,
  });
});
afterEach(async () => {
  await server.close();
  tempDirs.removeAll();
});

describe('POST /api/projects', () => {
  it('creates a project from a name alone', async () => {
    const res = await createProject({ name: '  Fleet  ' });

    expect(res.status).toBe(201);
    const project = (await res.json()) as Project;
    expect(project).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Fleet', docsFolderPath: null });
    expect(await listProjects()).toEqual([project]);
    expect(onDocsFolderSet).not.toHaveBeenCalled();
  });

  it('creates a project with a docs folder: lays out the four folders inside it, imports its existing notes and announces the folder', async () => {
    const folder = aFolder();
    mkdirSync(join(folder, 'specs'));
    writeFileSync(join(folder, 'specs', '2026-10-01-design.md'), '# Design');

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder });

    expect(res.status).toBe(201);
    const project = (await res.json()) as Project;
    expect(project.docsFolderPath).toBe(folder);
    expect(layoutOf(folder)).toEqual(LAYOUT);
    expect(db.prepare('SELECT title, folder FROM notes WHERE project_id = ?').all(project.id)).toEqual([{ title: 'design', folder: 'specs' }]);
    expect(onDocsFolderSet).toHaveBeenCalledExactlyOnceWith(project.id);
  });

  it('creates nothing beside the docs folder', async () => {
    const parent = tempDirs.make('of-link-parent-');
    const folder = join(parent, 'docs');
    mkdirSync(folder);

    await createProject({ name: 'Fleet', docsFolderPath: folder });

    expect(readdirSync(parent)).toEqual(['docs']);
  });

  it('allows two projects with the same name', async () => {
    await createProject({ name: 'Fleet' });
    const second = await createProject({ name: 'Fleet' });

    expect(second.status).toBe(201);
    expect(await listProjects()).toHaveLength(2);
  });

  it.each([
    ['a relative path', () => 'docs/notes'],
    ['a missing folder', () => join(aFolder(), 'not-there')],
    ['a file', () => { const file = join(aFolder(), 'notes.md'); writeFileSync(file, 'x'); return file; }],
  ])('refuses %s with invalid_body, stores no project and leaks no path', async (_label, pathOf) => {
    const docsFolderPath = pathOf();

    const res = await createProject({ name: 'Fleet', docsFolderPath });

    expect(res.status).toBe(400);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope).toMatchObject({ error: 'invalid_body', kind: 'invalid_request', retry: 'never' });
    expect(JSON.stringify(envelope)).not.toContain(docsFolderPath);
    expect(projectRowCount()).toBe(0);
    expect(onDocsFolderSet).not.toHaveBeenCalled();
  });

  it.skipIf(isRoot)('refuses a read-only folder with docs_folder_not_writable and stores no project', async () => {
    const folder = aFolder();
    chmodSync(folder, 0o500);

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder });

    expect(res.status).toBe(409);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope).toMatchObject({ error: 'docs_folder_not_writable', kind: 'conflict', retry: 'later' });
    expect(JSON.stringify(envelope)).not.toContain(folder);
    expect(projectRowCount()).toBe(0);
  });

  it('refuses a docs subfolder that is a symlink outside the folder with path_escapes_docs_folder and writes nothing outside', async () => {
    const folder = aFolder();
    const outside = tempDirs.make('of-link-outside-');
    symlinkSync(outside, join(folder, 'handoffs'));

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'path_escapes_docs_folder', retry: 'never' });
    expect(readdirSync(outside)).toEqual([]);
    expect(projectRowCount()).toBe(0);
  });

  it('refuses a note file that is a symlink outside the folder and leaves no project and no note behind', async () => {
    const folder = aFolder();
    const outside = tempDirs.make('of-link-outside-file-');
    writeFileSync(join(outside, 'secret.md'), 'secret');
    mkdirSync(join(folder, 'specs'));
    symlinkSync(join(outside, 'secret.md'), join(folder, 'specs', 'innocent.md'));

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'path_escapes_docs_folder' });
    expect(projectRowCount()).toBe(0);
    expect(noteRowCount()).toBe(0);
  });

  it.each([[{ name: '' }], [{ name: 'x'.repeat(81) }], [{}], [{ name: 'Fleet', id: 'forced' }], [{ name: 'Fleet', docsFolderPath: '' }]])('refuses the body %j with invalid_body', async (body) => {
    const res = await createProject(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(projectRowCount()).toBe(0);
  });

  it('refuses a request without the admin token', async () => {
    const res = await call('POST', '/api/projects', { name: 'Fleet' }, {});

    expect(res.status).toBe(401);
    expect(projectRowCount()).toBe(0);
  });
});

describe('PATCH /api/projects/:id', () => {
  const existingProject = async (body: Record<string, unknown> = { name: 'Fleet' }): Promise<Project> => (await (await createProject(body)).json()) as Project;

  it('sets the docs folder of a project that has none, lays it out and announces it', async () => {
    const project = await existingProject();
    const folder = aFolder();

    const res = await patchProject(project.id, { docsFolderPath: folder });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...project, docsFolderPath: folder });
    expect(layoutOf(folder)).toEqual(LAYOUT);
    expect(onDocsFolderSet).toHaveBeenCalledExactlyOnceWith(project.id);
    expect((await listProjects())[0]!.docsFolderPath).toBe(folder);
  });

  it('changes the docs folder to another one', async () => {
    const first = aFolder();
    const second = aFolder();
    const project = await existingProject({ name: 'Fleet', docsFolderPath: first });

    const res = await patchProject(project.id, { docsFolderPath: second });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Project).docsFolderPath).toBe(second);
    expect(layoutOf(second)).toEqual(LAYOUT);
  });

  it('renames a project without touching its folder or announcing one', async () => {
    const folder = aFolder();
    const project = await existingProject({ name: 'Fleet', docsFolderPath: folder });
    onDocsFolderSet.mockClear();

    const res = await patchProject(project.id, { name: ' Armada ' });

    expect(await res.json()).toEqual({ ...project, name: 'Armada' });
    expect(onDocsFolderSet).not.toHaveBeenCalled();
  });

  it('answers an unknown project with project_not_found, even for a bad path', async () => {
    const res = await patchProject(newId(), { docsFolderPath: 'relative' });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'project_not_found', kind: 'not_found' });
  });

  it.each([
    ['a relative path', () => 'docs'],
    ['a missing folder', () => join(aFolder(), 'gone')],
  ])('refuses %s and leaves the project unchanged', async (_label, pathOf) => {
    const project = await existingProject();

    const res = await patchProject(project.id, { name: 'Renamed', docsFolderPath: pathOf() });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(await listProjects()).toEqual([project]);
  });

  it('refuses a docs subfolder that escapes the folder and leaves the project unchanged', async () => {
    const project = await existingProject();
    const folder = aFolder();
    const outside = tempDirs.make('of-link-outside-');
    symlinkSync(outside, join(folder, 'plans'));

    const res = await patchProject(project.id, { docsFolderPath: folder });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'path_escapes_docs_folder' });
    expect(readdirSync(outside)).toEqual([]);
    expect(await listProjects()).toEqual([project]);
  });

  it.skipIf(isRoot)('refuses a read-only folder and leaves the project unchanged', async () => {
    const project = await existingProject();
    const folder = aFolder();
    chmodSync(folder, 0o500);

    const res = await patchProject(project.id, { docsFolderPath: folder });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'docs_folder_not_writable' });
    expect(await listProjects()).toEqual([project]);
  });

  it.each([[{}], [{ name: '' }], [{ createdAt: 'x' }]])('refuses the body %j', async (body) => {
    const project = await existingProject();

    const res = await patchProject(project.id, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('refuses a request without the admin token', async () => {
    const project = await existingProject();

    const res = await call('PATCH', `/api/projects/${project.id}`, { name: 'x' }, {});

    expect(res.status).toBe(401);
  });
});

describe('POST /api/sessions with a project', () => {
  it('links the session to the project and carries it on the response, the list and the get', async () => {
    const project = (await (await createProject({ name: 'Fleet' })).json()) as Project;

    const res = await createSession({ projectId: project.id });

    expect(res.status).toBe(201);
    const session = (await res.json()) as Session;
    expect(session.projectId).toBe(project.id);
    const listed = (await (await call('GET', '/api/sessions')).json()) as Session[];
    expect(listed.map((each) => each.projectId)).toEqual([project.id]);
  });

  it('answers an unknown project with project_not_found and creates no session', async () => {
    const res = await createSession({ projectId: newId() });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'project_not_found', kind: 'not_found', retry: 'never' });
    expect(await (await call('GET', '/api/sessions')).json()).toEqual([]);
  });

  it('refuses a malformed project id with invalid_body', async () => {
    const res = await createSession({ projectId: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('links a manager session to the project too', async () => {
    const project = (await (await createProject({ name: 'Fleet' })).json()) as Project;

    const res = await createSession({ projectId: project.id, manager: { mission: 'Keep shipping', childrenCap: 2 } });

    expect(res.status).toBe(201);
    expect(((await res.json()) as Session).projectId).toBe(project.id);
  });
});

describe('GET /api/sessions/:id/handoff-target for a linked session', () => {
  const targetOf = async (sessionId: string) => (await (await call('GET', `/api/sessions/${sessionId}/handoff-target`)).json()) as HandoffTarget;
  const sessionOf = async (projectId?: string) => ((await (await createSession(projectId ? { projectId } : {})).json()) as Session).id;

  it('is available with a relative path under handoffs when the project has a docs folder', async () => {
    const folder = aFolder();
    const project = (await (await createProject({ name: 'Fleet', docsFolderPath: folder })).json()) as Project;

    const target = await targetOf(await sessionOf(project.id));

    expect(target).toEqual({ available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: true });
  });

  it('is unavailable with no_docs_folder when the project has no folder yet, then available once a folder is set', async () => {
    const project = (await (await createProject({ name: 'Fleet' })).json()) as Project;
    const sessionId = await sessionOf(project.id);

    expect(await targetOf(sessionId)).toMatchObject({ available: false, reason: 'no_docs_folder' });

    await patchProject(project.id, { docsFolderPath: aFolder() });

    expect(await targetOf(sessionId)).toMatchObject({ available: true, relativePath: 'handoffs/2026-10-04-gimli.md' });
  });

  it('is unavailable with no_project for a session without a project', async () => {
    expect(await targetOf(await sessionOf())).toMatchObject({ available: false, reason: 'no_project' });
  });

  it('does not write anything into the docs folder', async () => {
    const folder = aFolder();
    const project = (await (await createProject({ name: 'Fleet', docsFolderPath: folder })).json()) as Project;

    await targetOf(await sessionOf(project.id));

    expect(readdirSync(join(folder, 'handoffs'))).toEqual([]);
    expect(existsSync(join(folder, 'handoffs'))).toBe(true);
  });
});
