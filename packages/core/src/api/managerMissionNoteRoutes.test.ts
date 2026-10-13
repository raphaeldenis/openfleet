import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { startServer } from './server.js';

const OWN_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

let server: Awaited<ReturnType<typeof startServer>>;
let noteRepo: NoteRepository;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepository = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus });
  noteRepo = new NoteRepository(db);
  const storeRepo = new DataStoreRepository(db);
  const managers = new ManagerService({
    managers: managerRepository, sessions, bus, scheduler: pulseScheduler,
    linkTargets: { noteProjectId: (noteId) => noteRepo.getProjectId(noteId), storeProjectId: (storeId) => storeRepo.findStore(storeId)?.projectId },
  });
  const projects = new ProjectRepository(db);
  projects.insert({ id: OWN_PROJECT_ID, name: 'Own', docsFolderPath: null, createdAt: CREATED_AT });
  projects.insert({ id: OTHER_PROJECT_ID, name: 'Other', docsFolderPath: null, createdAt: CREATED_AT });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json',
  });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin' } });
const patchJson = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

const insertNote = (input: { id: string; projectId: string }) =>
  noteRepo.insert({ ...input, title: 'Mission', bodyMd: '# Mission', folder: null, filePath: null, sourceHash: null, rev: 1, shared: false, createdAt: CREATED_AT, updatedAt: CREATED_AT });

async function createManagerOfOwnProject(): Promise<string> {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', projectId: OWN_PROJECT_ID, manager: { pulseSeconds: 600, childrenCap: 4, mission: 'Ship it' } }),
  });
  return ((await response.json()) as { id: string }).id;
}

describe('PATCH /api/managers/:id with a mission note', () => {
  it('links a note of the manager\'s project and pins it, and GET shows both', async () => {
    const managerId = await createManagerOfOwnProject();
    insertNote({ id: 'note-mission', projectId: OWN_PROJECT_ID });

    const response = await patchJson(`/api/managers/${managerId}`, { missionNoteId: 'note-mission', pinMissionNote: true });

    expect(response.status).toBe(200);
    const profile = await (await api(`/api/managers/${managerId}`)).json();
    expect(profile.manager).toMatchObject({ missionNoteId: 'note-mission', pinMissionNote: true });
  });

  it('404s a note of another project and changes nothing', async () => {
    const managerId = await createManagerOfOwnProject();
    insertNote({ id: 'note-foreign', projectId: OTHER_PROJECT_ID });

    const response = await patchJson(`/api/managers/${managerId}`, { missionNoteId: 'note-foreign', childrenCap: 9 });

    expect(response.status).toBe(404);
    const profile = await (await api(`/api/managers/${managerId}`)).json();
    expect(profile.manager).toMatchObject({ childrenCap: 4 });
    expect(profile.manager.missionNoteId).toBeUndefined();
  });

  it('unlinks the mission note when given null', async () => {
    const managerId = await createManagerOfOwnProject();
    insertNote({ id: 'note-mission', projectId: OWN_PROJECT_ID });
    await patchJson(`/api/managers/${managerId}`, { missionNoteId: 'note-mission' });

    const response = await patchJson(`/api/managers/${managerId}`, { missionNoteId: null });

    expect(response.status).toBe(200);
    expect((await (await api(`/api/managers/${managerId}`)).json()).manager.missionNoteId).toBeUndefined();
  });
});
