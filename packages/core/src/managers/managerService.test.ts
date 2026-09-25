import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from './managerRepository.js';
import { ManagerService } from './managerService.js';
import { SessionService } from '../sessions/sessionService.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'of-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function setup() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managerRepo = new ManagerRepository(db);
  const scheduler = { onManagerCreated: vi.fn(), pulseNow: vi.fn(), start: vi.fn(), stop: vi.fn() };
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

describe('ManagerService.createManagerSession — worktrees', () => {
  it('creates the worktree first, exactly as the non-manager path does, and launches the manager inside it', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot });
    const managerRepo = new ManagerRepository(db);
    const scheduler = { onManagerCreated: vi.fn(), pulseNow: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const service = new ManagerService({ managers: managerRepo, sessions, bus, scheduler });

    const session = await service.createManagerSession({
      directory: repoPath, name: 'Lead', emoji: '🧭', harness: 'fake', repoPath, branchName: 'task/CCM-6',
      manager: { pulseSeconds: 60, childrenCap: 1, mission: 'Ship it' },
    } as never);

    expect(session.directory).toBe(join(worktreesRoot, 'task-CCM-6'));
    expect(session.role).toBe('manager');
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
