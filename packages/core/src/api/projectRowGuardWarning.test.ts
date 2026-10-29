import type { Page, Project } from '@openfleet/shared';
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
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService, DoneWithoutPrUrlError } from '../stores/dataStoreService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { startServer } from './server.js';

const CLOCK = '2026-10-29T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const PROJECT_ID = 'p1';
const scope = { projectId: PROJECT_ID } as const;
const human = { kind: 'human', label: 'You' } as const;
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let stores: DataStoreService;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const switchGuardOn = async (): Promise<Project> => (await call('PATCH', `/api/projects/${PROJECT_ID}`, { rowGuardEnabled: true })).json() as Promise<Project>;
const listProjects = async () => ((await (await call('GET', '/api/projects')).json()) as Page<Project>).items;

/** A kanban whose `status` and `step` columns are of the given type; a select gets the labels the done rule reads. */
function kanbanWith(columnType: 'text' | 'select') {
  const store = stores.createStore({ ...scope, displayName: 'kanban' });
  const column = (displayName: string, options?: { id: string; label: string }[]) =>
    stores.addColumn(store.id, { ...scope, displayName, columnType, ...(options ? { options } : {}) }).id;
  const isSelect = columnType === 'select';
  const prUrl = stores.addColumn(store.id, { ...scope, displayName: 'pr_url', columnType: 'text' }).id;
  const status = column('status', isSelect ? [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }] : undefined);
  const step = column('step', isSelect ? [{ id: 'build', label: 'build' }, { id: 'cancelled', label: 'cancelled' }] : undefined);
  const row = stores.insertRow(store.id, { ...scope, data: { [status]: 'todo' }, actor: human });
  const markDoneWithoutPrUrl = () => stores.updateRow(store.id, row.id, { ...scope, patch: { [status]: 'done' }, actor: human });
  return { markDoneWithoutPrUrl, step, prUrl };
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: tempDirs.make('of-guard-warning-wt-'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: CLOCK });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, noteRepo, clock: () => CLOCK, newId });
  const storeRepo = new DataStoreRepository(db);
  let counter = 0;
  stores = new DataStoreService({ repo: storeRepo, db, clock: () => CLOCK, newId: () => `id-${++counter}` });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService, stores, storeRepo,
  });
});
afterEach(async () => {
  await server.close();
  tempDirs.removeAll();
});

describe('the "done needs a pr_url" guard on text status and step columns', () => {
  it('warns when the guard is switched on while status and step are text columns, and the done write goes through', async () => {
    const { markDoneWithoutPrUrl } = kanbanWith('text');

    const project = await switchGuardOn();

    expect(project.rowGuardWarning).toMatch(/status/);
    expect(project.rowGuardWarning).toMatch(/step/);
    expect(project.rowGuardWarning).toMatch(/select/);
    expect(markDoneWithoutPrUrl).not.toThrow();
  });

  it('keeps the warning on the project listing, so the project card shows it', async () => {
    kanbanWith('text');
    await switchGuardOn();

    const [listed] = await listProjects();

    expect(listed?.rowGuardWarning).toMatch(/status/);
  });

  it('gives no warning when status and step are select columns, and refuses done without a pr_url', async () => {
    const { markDoneWithoutPrUrl } = kanbanWith('select');

    const project = await switchGuardOn();

    expect(project).not.toHaveProperty('rowGuardWarning');
    expect(markDoneWithoutPrUrl).toThrow(DoneWithoutPrUrlError);
  });

  it('gives no warning for a store that has a text status column but no pr_url column, since the rule never applies there', async () => {
    const store = stores.createStore({ ...scope, displayName: 'tasks' });
    stores.addColumn(store.id, { ...scope, displayName: 'status', columnType: 'text' });
    stores.addColumn(store.id, { ...scope, displayName: 'step', columnType: 'text' });

    const project = await switchGuardOn();

    expect(project).not.toHaveProperty('rowGuardWarning');
  });

  it('says a text step column makes the guard stricter by disabling the cancelled exception, while status is a select', async () => {
    const store = stores.createStore({ ...scope, displayName: 'kanban' });
    stores.addColumn(store.id, { ...scope, displayName: 'pr_url', columnType: 'text' });
    stores.addColumn(store.id, { ...scope, displayName: 'status', columnType: 'select', options: [{ id: 'done', label: 'done' }] });
    stores.addColumn(store.id, { ...scope, displayName: 'step', columnType: 'text' });

    const project = await switchGuardOn();

    expect(project.rowGuardWarning).toMatch(/step/);
    expect(project.rowGuardWarning).toMatch(/cancelled/);
    expect(project.rowGuardWarning).toMatch(/stricter|still refuses/);
    expect(project.rowGuardWarning).not.toMatch(/does not check/);
  });

  it('gives no warning while the guard is off', async () => {
    kanbanWith('text');

    const [listed] = await listProjects();

    expect(listed).not.toHaveProperty('rowGuardWarning');
  });
});
