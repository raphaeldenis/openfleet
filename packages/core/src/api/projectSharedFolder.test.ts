import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorEnvelope, Page, Project } from '@openfleet/shared';
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
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let projects: ProjectRepository;
let docsFolder: string;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const listProjects = async () => ((await (await call('GET', '/api/projects')).json()) as Page<Project>).items;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: tempDirs.make('of-shared-folder-wt-'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, noteRepo, clock: () => CLOCK, newId });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService,
  });
  docsFolder = realpathSync(tempDirs.make('of-shared-folder-docs-'));
});
afterEach(async () => {
  await server.close();
  tempDirs.removeAll();
});

describe('projects that share a docs folder', () => {
  it('lists, on each of them, the names of the other projects that use its folder', async () => {
    projects.insert({ id: 'p1', name: 'Fleet', docsFolderPath: docsFolder, createdAt: CLOCK });
    projects.insert({ id: 'p2', name: 'Fleet copy', docsFolderPath: docsFolder, createdAt: CLOCK });

    const listed = await listProjects();

    expect(listed.find((project) => project.id === 'p1')?.docsFolderSharedWith).toEqual(['Fleet copy']);
    expect(listed.find((project) => project.id === 'p2')?.docsFolderSharedWith).toEqual(['Fleet']);
  });

  it('leaves the warning off a project whose folder is its own', async () => {
    const ownFolder = join(docsFolder, 'Own');
    mkdirSync(ownFolder);
    projects.insert({ id: 'p1', name: 'Fleet', docsFolderPath: ownFolder, createdAt: CLOCK });
    projects.insert({ id: 'p2', name: 'Other', docsFolderPath: docsFolder, createdAt: CLOCK });
    projects.insert({ id: 'p3', name: 'No folder', docsFolderPath: null, createdAt: CLOCK });

    const listed = await listProjects();

    expect(listed.every((project) => !('docsFolderSharedWith' in project))).toBe(true);
  });

  it('answers 409 docs_folder_already_used naming the project when a creation takes a used folder', async () => {
    projects.insert({ id: 'p1', name: 'Fleet', docsFolderPath: docsFolder, createdAt: CLOCK });

    const res = await call('POST', '/api/projects', { name: 'Again', docsFolderPath: docsFolder });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'docs_folder_already_used', kind: 'conflict', retry: 'never', message: expect.stringContaining('Fleet') } satisfies Partial<ErrorEnvelope>);
  });
});
