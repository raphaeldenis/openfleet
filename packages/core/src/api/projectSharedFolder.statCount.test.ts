import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Project } from '@openfleet/shared';
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
import { startServer } from './server.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const CLOCK = '2026-10-29T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const PROJECT_COUNT = 6;
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let docsFolders: string[];

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: tempDirs.make('of-stat-count-wt-'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, noteRepo, clock: () => CLOCK, newId });
  const docsRoot = realpathSync(tempDirs.make('of-stat-count-docs-'));
  docsFolders = Array.from({ length: PROJECT_COUNT }, (_, index) => join(docsRoot, `project-${index}`));
  docsFolders.forEach((folder, index) => {
    mkdirSync(folder);
    projects.insert({ id: `p${index}`, name: `Project ${index}`, docsFolderPath: folder, createdAt: CLOCK });
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

describe('the project listing', () => {
  it('reads the identity of each docs folder once, however many projects it lists', async () => {
    vi.mocked(statSync).mockClear();

    const res = await fetch(`${server.url}/api/projects`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

    const listed = (await res.json()) as Page<Project>;
    const statsOfDocsFolders = vi.mocked(statSync).mock.calls.filter(([path]) => docsFolders.includes(String(path)));
    expect(listed.items).toHaveLength(PROJECT_COUNT);
    expect(statsOfDocsFolders).toHaveLength(PROJECT_COUNT);
  });
});
