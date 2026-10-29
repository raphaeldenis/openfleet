import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { renderProjectNote, type ErrorEnvelope, type NoteSummary, type Page, type Project } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { startServer } from './server.js';

const CLOCK = '2026-10-29T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const isRoot = process.getuid?.() === 0;
const tempDirs = createTempDirTracker();

const PROFILE = {
  goal: 'Ship the daemon',
  stack: ['TypeScript', 'Vue 3'],
  commands: { install: 'pnpm install', test: 'pnpm test' },
  repositories: ['/work/fleet'],
};

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let watchedProjectIds: string[];
let forgottenProjectIds: string[];

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const createProject = (body: unknown) => call('POST', '/api/projects', body);
const listNotes = async (projectId: string) => ((await (await call('GET', `/api/notes?projectId=${projectId}`)).json()) as Page<NoteSummary>).items;
const bodiesOf = (projectId: string) => (db.prepare('SELECT body_md FROM notes WHERE project_id = ?').all(projectId) as { body_md: string }[]).map((row) => row.body_md);
const projectRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
const aFolder = () => tempDirs.make('of-profile-docs-');

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(tempDirs.make('of-profile-wt-'), 'wt'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  watchedProjectIds = [];
  forgottenProjectIds = [];
  const projectService = new ProjectService({
    projects, docs, noteRepo, clock: () => CLOCK, newId,
    onDocsFolderSet: (projectId) => watchedProjectIds.push(projectId),
    onProjectForgotten: (projectId) => forgottenProjectIds.push(projectId),
  });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService,
  });
});
afterEach(async () => {
  await server.close();
  tempDirs.removeAll();
});

describe('POST /api/projects with a profile', () => {
  it('writes the "Project: <name>" note, as a listed note and as a file in the docs folder, with the rendered body', async () => {
    const folder = aFolder();

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder, profile: PROFILE });

    expect(res.status).toBe(201);
    const project = (await res.json()) as Project;
    const expectedBody = renderProjectNote({ name: 'Fleet', ...PROFILE });
    expect((await listNotes(project.id)).map((note) => note.title)).toEqual(['Project: Fleet']);
    expect(bodiesOf(project.id)).toEqual([expectedBody]);
    const [fileName] = readdirSync(join(folder, 'specs'));
    expect(readFileSync(join(folder, 'specs', fileName!), 'utf8')).toBe(expectedBody);
  });

  it('writes no note when there is no profile', async () => {
    const res = await createProject({ name: 'Fleet', docsFolderPath: aFolder() });

    const project = (await res.json()) as Project;
    expect(await listNotes(project.id)).toEqual([]);
  });

  it('leaves a project note already in the docs folder alone instead of writing a second one', async () => {
    const folder = aFolder();
    mkdirSync(join(folder, 'specs'));
    const editedBody = '# Project: Fleet\n\n## Goal\nEdited by hand\n';
    writeFileSync(join(folder, 'specs', '2026-09-01-project-fleet.md'), editedBody);

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder, profile: PROFILE });

    const project = (await res.json()) as Project;
    expect(bodiesOf(project.id)).toEqual([editedBody]);
    expect(readdirSync(join(folder, 'specs'))).toEqual(['2026-09-01-project-fleet.md']);
  });

  it('refuses a profile without a docs folder path', async () => {
    const res = await createProject({ name: 'Fleet', profile: PROFILE });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error).toBe('invalid_body');
    expect(projectRowCount()).toBe(0);
  });

  it('refuses a 10 KB goal', async () => {
    const res = await createProject({ name: 'Fleet', docsFolderPath: aFolder(), profile: { goal: 'x'.repeat(10_000) } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error).toBe('invalid_body');
    expect(projectRowCount()).toBe(0);
  });

  it('keeps a hostile name to one title line in the note', async () => {
    const res = await createProject({ name: 'Fleet {{x}}\n## Injected', docsFolderPath: aFolder(), profile: PROFILE });

    const project = (await res.json()) as Project;
    const [body] = bodiesOf(project.id);
    expect(body!.split('\n')[0]).toBe('# Project: Fleet x ## Injected');
  });

  it.skipIf(isRoot)('keeps no project when the note cannot be written', async () => {
    const folder = aFolder();
    mkdirSync(join(folder, 'specs'));
    chmodSync(join(folder, 'specs'), 0o500);

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder, profile: PROFILE });

    chmodSync(join(folder, 'specs'), 0o700);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(projectRowCount()).toBe(0);
  });

  it.skipIf(isRoot)('keeps no project, answers a write error and stops the watcher when the folder already holds notes and the write fails', async () => {
    const folder = aFolder();
    mkdirSync(join(folder, 'specs'));
    writeFileSync(join(folder, 'specs', '2026-09-01-old.md'), '# Old\n');
    chmodSync(join(folder, 'specs'), 0o500);

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder, profile: PROFILE });

    chmodSync(join(folder, 'specs'), 0o700);
    expect(((await res.json()) as ErrorEnvelope).error).not.toBe('project_not_found');
    expect(projectRowCount()).toBe(0);
    expect(forgottenProjectIds).toEqual(watchedProjectIds);
    expect(forgottenProjectIds).toHaveLength(1);
  });

  it.each([
    ['another letter case', '# project: fleet\n\n## Goal\nEdited\n'],
    ['CRLF line ends', '# Project: Fleet\r\n\r\n## Goal\r\nEdited\r\n'],
  ])('leaves a project note already in the docs folder alone with %s', async (_label, editedBody) => {
    const folder = aFolder();
    mkdirSync(join(folder, 'specs'));
    writeFileSync(join(folder, 'specs', '2026-09-01-project-fleet.md'), editedBody);

    const res = await createProject({ name: 'Fleet', docsFolderPath: folder, profile: PROFILE });

    const project = (await res.json()) as Project;
    expect(readdirSync(join(folder, 'specs'))).toEqual(['2026-09-01-project-fleet.md']);
    expect(bodiesOf(project.id)).toHaveLength(1);
  });

  it('refuses a name made only of template braces', async () => {
    const res = await createProject({ name: '{{}}', docsFolderPath: aFolder(), profile: PROFILE });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error).toBe('invalid_body');
    expect(projectRowCount()).toBe(0);
  });
});
