import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { makeRepo } from '../git/testRepo.js';
import { ManagerRepository } from './managerRepository.js';
import { ManagerService } from './managerService.js';
import { SessionService } from '../sessions/sessionService.js';

function setup() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managerRepo = new ManagerRepository(db);
  const scheduler = { onManagerCreated: vi.fn(), onManagerUpdated: vi.fn(), pulseNow: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const service = new ManagerService({ managers: managerRepo, sessions, bus, scheduler });
  return { db, bus, sessions, managerRepo, scheduler, service };
}

describe('ManagerService.createManagerSession', () => {
  it('creates a role=manager session, seeds the mission as the prompt, and records the manager', async () => {
    const { service, managerRepo, scheduler } = setup();
    const session = await service.createManagerSession({
      directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake',
      manager: { pulseSeconds: 1800, childrenCap: 2, mission: 'Ship phase 2' },
    } as never);

    expect(session.role).toBe('manager');
    expect(managerRepo.get(session.id)).toMatchObject({ sessionId: session.id, pulseSeconds: 1800, childrenCap: 2, missionText: 'Ship phase 2' });
    expect(scheduler.onManagerCreated).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id }));
  });

  it('emits manager.created with a view that already reflects zero children', async () => {
    const { service, bus } = setup();
    const events: unknown[] = [];
    bus.subscribe((e) => events.push(e));
    const session = await service.createManagerSession({
      directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake',
      manager: { pulseSeconds: 60, childrenCap: 1, mission: 'x' },
    } as never);
    expect(events).toContainEqual({ type: 'manager.created', manager: expect.objectContaining({ sessionId: session.id, childrenCount: 0, childrenCap: 1 }) });
  });
});

describe('ManagerService.createManagerSession — heartbeat default', () => {
  const managerWithoutPulseSeconds = { directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { childrenCap: 2, mission: 'Ship' } } as never;

  function serviceWithHeartbeatDefault(heartbeatDefaultSeconds?: number) {
    const { db, bus, sessions, scheduler } = setup();
    const managerRepo = new ManagerRepository(db);
    const service = new ManagerService({ managers: managerRepo, sessions, bus, scheduler, heartbeatDefaultSeconds });
    return { service, managerRepo };
  }

  it('a manager created without a heartbeat gets the default of the settings', async () => {
    const { service, managerRepo } = serviceWithHeartbeatDefault(600);

    const session = await service.createManagerSession(managerWithoutPulseSeconds);

    expect(managerRepo.get(session.id)?.pulseSeconds).toBe(600);
  });

  it('a manager created without a heartbeat and without a setting gets 1800 seconds', async () => {
    const { service, managerRepo } = serviceWithHeartbeatDefault(undefined);

    const session = await service.createManagerSession(managerWithoutPulseSeconds);

    expect(managerRepo.get(session.id)?.pulseSeconds).toBe(1800);
  });

  it('a manager created with its own heartbeat keeps it whatever the setting says', async () => {
    const { service, managerRepo } = serviceWithHeartbeatDefault(600);

    const session = await service.createManagerSession({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 45, childrenCap: 2, mission: 'Ship' } } as never);

    expect(managerRepo.get(session.id)?.pulseSeconds).toBe(45);
  });
});

describe('ManagerService.createManagerSession — worktrees', () => {
  it('creates the worktree first, exactly as the non-manager path does, and launches the manager inside it', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot });
    const managerRepo = new ManagerRepository(db);
    const scheduler = { onManagerCreated: vi.fn(), onManagerUpdated: vi.fn(), pulseNow: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const service = new ManagerService({ managers: managerRepo, sessions, bus, scheduler });

    const session = await service.createManagerSession({
      directory: repoPath, name: 'Lead', emoji: '🧭', harness: 'fake', repoPath, branchName: 'task/CCM-6',
      manager: { pulseSeconds: 60, childrenCap: 1, mission: 'Ship it' },
    } as never);

    expect(session.directory).toBe(join(worktreesRoot, 'task-CCM-6'));
    expect(session.role).toBe('manager');
  });
});

describe('ManagerService.update', () => {
  async function aManager() {
    const world = setup();
    const session = await world.service.createManagerSession({
      directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake',
      manager: { pulseSeconds: 600, childrenCap: 4, mission: 'Ship phase 2' },
    } as never);
    return { ...world, managerId: session.id };
  }

  it('persists the edited pulse, cap and mission, and keeps the fields it was not given', async () => {
    const { service, managerRepo, managerId } = await aManager();

    service.update(managerId, { pulseSeconds: 300, childrenCap: 8 });
    service.update(managerId, { mission: 'Ship phase 3' });

    expect(managerRepo.get(managerId)).toMatchObject({ pulseSeconds: 300, childrenCap: 8, missionText: 'Ship phase 3' });
  });

  it('announces the edited manager to the clients', async () => {
    const { service, bus, managerId } = await aManager();
    const events: unknown[] = [];
    bus.subscribe((event) => events.push(event));

    service.update(managerId, { childrenCap: 8 });

    expect(events).toContainEqual({ type: 'manager.updated', manager: expect.objectContaining({ sessionId: managerId, childrenCap: 8, pulseSeconds: 600 }) });
  });

  it('tells the pulse scheduler about the new cadence', async () => {
    const { service, scheduler, managerRepo, managerId } = await aManager();

    service.update(managerId, { pulseSeconds: 300 });

    expect(scheduler.onManagerUpdated).toHaveBeenCalledWith(expect.objectContaining({ sessionId: managerId, pulseSeconds: 300 }));
    expect(managerRepo.get(managerId)?.pulseSeconds).toBe(300);
  });

  it('answers nothing for a session that is no manager', () => {
    const { service } = setup();

    expect(service.update('nobody', { childrenCap: 2 })).toBeUndefined();
  });
});

describe('ManagerService.listViews', () => {
  it('counts only non-closed children', async () => {
    const { service, sessions } = setup();
    const manager = await service.createManagerSession({
      directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake',
      manager: { pulseSeconds: 60, childrenCap: 3, mission: 'x' },
    } as never);
    const child = await sessions.create({ directory: '/tmp', name: 'Gimli', emoji: '⚔️', harness: 'fake', parentId: manager.id });
    await sessions.close(child.id);
    const closedChildViewCount = service.listViews().find((v) => v.sessionId === manager.id)!.childrenCount;
    expect(closedChildViewCount).toBe(0);

    await sessions.create({ directory: '/tmp', name: 'Legolas', emoji: '🏹', harness: 'fake', parentId: manager.id });
    const liveChildViewCount = service.listViews().find((v) => v.sessionId === manager.id)!.childrenCount;
    expect(liveChildViewCount).toBe(1);
  });
});
