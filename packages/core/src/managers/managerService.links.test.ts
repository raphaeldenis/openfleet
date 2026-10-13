import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteNotFoundError } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository, StoreNotFoundError } from '../stores/dataStoreRepository.js';
import { ManagerRepository } from './managerRepository.js';
import { ManagerService } from './managerService.js';

const OWN_PROJECT_ID = 'project-own';
const OTHER_PROJECT_ID = 'project-other';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function setup() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managerRepo = new ManagerRepository(db);
  const scheduler = { onManagerCreated: vi.fn(), onManagerUpdated: vi.fn() };
  const noteRepo = new NoteRepository(db);
  const storeRepo = new DataStoreRepository(db);
  const linkTargets = {
    noteProjectId: (noteId: string) => noteRepo.getProjectId(noteId),
    storeProjectId: (storeId: string) => storeRepo.findStore(storeId)?.projectId,
  };
  const service = new ManagerService({ managers: managerRepo, sessions, bus, scheduler, linkTargets });
  const projects = new ProjectRepository(db);
  projects.insert({ id: OWN_PROJECT_ID, name: 'Own', docsFolderPath: null, createdAt: CREATED_AT });
  projects.insert({ id: OTHER_PROJECT_ID, name: 'Other', docsFolderPath: null, createdAt: CREATED_AT });
  return { db, bus, sessions, scheduler, managerRepo, noteRepo, storeRepo, service };
}

type World = ReturnType<typeof setup>;

async function aManagerOfTheOwnProject(world: World) {
  const session = await world.service.createManagerSession({
    directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake',
    manager: { pulseSeconds: 600, childrenCap: 4, mission: 'Ship' },
  } as never);
  world.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(OWN_PROJECT_ID, session.id);
  return session.id;
}

const insertNote = (world: World, input: { id: string; projectId: string }) =>
  world.noteRepo.insert({ ...input, title: 'Mission', bodyMd: '# Mission', folder: null, filePath: null, sourceHash: null, rev: 1, shared: false, createdAt: CREATED_AT, updatedAt: CREATED_AT });

const insertStore = (world: World, input: { id: string; projectId: string }) =>
  world.storeRepo.createStore({ ...input, displayName: `log ${input.id}`, at: CREATED_AT });

describe('ManagerService.update — mission note', () => {
  it('links a note of the manager\'s own project and shows it in the manager view', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertNote(world, { id: 'note-mission', projectId: OWN_PROJECT_ID });

    const view = world.service.update(managerId, { missionNoteId: 'note-mission' });

    expect(view).toMatchObject({ missionNoteId: 'note-mission' });
    expect(world.managerRepo.get(managerId)?.missionNoteId).toBe('note-mission');
  });

  it('refuses a note that does not exist and keeps the manager untouched', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);

    expect(() => world.service.update(managerId, { missionNoteId: 'no-such-note', childrenCap: 9 })).toThrow(NoteNotFoundError);

    expect(world.managerRepo.get(managerId)).toMatchObject({ missionNoteId: undefined, childrenCap: 4 });
  });

  it('refuses a note of another project exactly like a missing note', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertNote(world, { id: 'note-foreign', projectId: OTHER_PROJECT_ID });

    expect(() => world.service.update(managerId, { missionNoteId: 'note-foreign' })).toThrow(NoteNotFoundError);
    expect(world.managerRepo.get(managerId)?.missionNoteId).toBeUndefined();
  });

  it('unlinks the mission note when given null', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertNote(world, { id: 'note-mission', projectId: OWN_PROJECT_ID });
    world.service.update(managerId, { missionNoteId: 'note-mission' });

    world.service.update(managerId, { missionNoteId: null });

    expect(world.managerRepo.get(managerId)?.missionNoteId).toBeUndefined();
  });

  it('pins and unpins the mission note', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);

    const pinned = world.service.update(managerId, { pinMissionNote: true });
    const unpinned = world.service.update(managerId, { pinMissionNote: false });

    expect(pinned?.pinMissionNote).toBe(true);
    expect(unpinned?.pinMissionNote).toBe(false);
  });

  it('announces the linked note to the clients', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertNote(world, { id: 'note-mission', projectId: OWN_PROJECT_ID });
    const events: unknown[] = [];
    world.bus.subscribe((event) => events.push(event));

    world.service.update(managerId, { missionNoteId: 'note-mission' });

    expect(events).toContainEqual({ type: 'manager.updated', manager: expect.objectContaining({ sessionId: managerId, missionNoteId: 'note-mission' }) });
  });

  it('deleting the linked note leaves the manager without a mission note', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertNote(world, { id: 'note-mission', projectId: OWN_PROJECT_ID });
    world.service.update(managerId, { missionNoteId: 'note-mission' });

    world.db.prepare('DELETE FROM notes WHERE id = ?').run('note-mission');

    expect(world.managerRepo.get(managerId)?.missionNoteId).toBeUndefined();
  });
});

describe('ManagerService.bindLogStore', () => {
  it('binds a table of the manager\'s own project and shows it in the manager view', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertStore(world, { id: 'store-log', projectId: OWN_PROJECT_ID });

    const view = world.service.bindLogStore(managerId, 'store-log');

    expect(view).toMatchObject({ sessionId: managerId, logStoreId: 'store-log' });
    expect(world.managerRepo.get(managerId)?.logStoreId).toBe('store-log');
  });

  it('refuses a table that does not exist', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);

    expect(() => world.service.bindLogStore(managerId, 'no-such-store')).toThrow(StoreNotFoundError);
    expect(world.managerRepo.get(managerId)?.logStoreId).toBeUndefined();
  });

  it('refuses a table of another project exactly like a missing table', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertStore(world, { id: 'store-foreign', projectId: OTHER_PROJECT_ID });

    expect(() => world.service.bindLogStore(managerId, 'store-foreign')).toThrow(StoreNotFoundError);
    expect(world.managerRepo.get(managerId)?.logStoreId).toBeUndefined();
  });

  it('refuses every table for a manager that belongs to no project', async () => {
    const world = setup();
    const session = await world.service.createManagerSession({ directory: '/tmp', name: 'Loner', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 600, childrenCap: 1, mission: 'x' } } as never);
    insertStore(world, { id: 'store-log', projectId: OWN_PROJECT_ID });

    expect(() => world.service.bindLogStore(session.id, 'store-log')).toThrow(StoreNotFoundError);
  });

  it('answers nothing for a session that is no manager', () => {
    const world = setup();
    insertStore(world, { id: 'store-log', projectId: OWN_PROJECT_ID });

    expect(world.service.bindLogStore('nobody', 'store-log')).toBeUndefined();
  });

  it('rebinding replaces the previous table and leaves the other managers alone', async () => {
    const world = setup();
    const firstManagerId = await aManagerOfTheOwnProject(world);
    const secondManagerId = await aManagerOfTheOwnProject(world);
    insertStore(world, { id: 'store-first', projectId: OWN_PROJECT_ID });
    insertStore(world, { id: 'store-second', projectId: OWN_PROJECT_ID });
    world.service.bindLogStore(secondManagerId, 'store-second');

    world.service.bindLogStore(firstManagerId, 'store-first');
    world.service.bindLogStore(firstManagerId, 'store-second');

    expect(world.managerRepo.get(firstManagerId)?.logStoreId).toBe('store-second');
    expect(world.managerRepo.get(secondManagerId)?.logStoreId).toBe('store-second');
  });

  it('does not restart the pulse cadence of the manager', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertStore(world, { id: 'store-log', projectId: OWN_PROJECT_ID });

    world.service.bindLogStore(managerId, 'store-log');

    expect(world.scheduler.onManagerUpdated).not.toHaveBeenCalled();
  });

  it('deleting the bound table leaves the manager without a log table', async () => {
    const world = setup();
    const managerId = await aManagerOfTheOwnProject(world);
    insertStore(world, { id: 'store-log', projectId: OWN_PROJECT_ID });
    world.service.bindLogStore(managerId, 'store-log');

    world.storeRepo.deleteStore('store-log');

    expect(world.managerRepo.get(managerId)?.logStoreId).toBeUndefined();
  });
});

describe('ManagerService links without link targets', () => {
  it('refuses to link anything when no link targets are wired', async () => {
    const world = setup();
    const unwired = new ManagerService({ managers: world.managerRepo, sessions: world.sessions, bus: world.bus, scheduler: { onManagerCreated: vi.fn(), onManagerUpdated: vi.fn() } });
    const managerId = await aManagerOfTheOwnProject(world);
    insertStore(world, { id: 'store-log', projectId: OWN_PROJECT_ID });

    expect(() => unwired.bindLogStore(managerId, 'store-log')).toThrow(StoreNotFoundError);
  });
});
