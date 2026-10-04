import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { makeRepo } from '../git/testRepo.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ProjectNotFoundError } from '../projects/projectErrors.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from './sessionService.js';

const SPEC = { directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' } as const;

function setup() {
  const db = openDatabase(':memory:');
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const worktreesRoot = join(mkdtempSync(join(tmpdir(), 'of-link-wt-')), 'worktrees');
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot });
  const projects = new ProjectRepository(db);
  const aProject = () => {
    const id = newId();
    projects.insert({ id, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
    return id;
  };
  const sessionRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  return { db, harness, events, service, aProject, sessionRowCount, worktreesRoot };
}

describe('SessionService create with a project', () => {
  it('persists the project id and returns it on the session, on get and on the created event', async () => {
    const { service, aProject, events, db } = setup();
    const projectId = aProject();

    const session = await service.create({ ...SPEC, projectId });

    expect(session.projectId).toBe(projectId);
    expect(service.get(session.id)?.projectId).toBe(projectId);
    expect(service.list().map((listed) => listed.projectId)).toEqual([projectId]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'session.created', session: expect.objectContaining({ projectId }) }));
    expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(session.id)).toEqual({ project_id: projectId });
  });

  it('leaves the project unset when none is given', async () => {
    const { service } = setup();

    const session = await service.create(SPEC);

    expect(session.projectId).toBeUndefined();
  });

  it('refuses an unknown project before inserting a row or starting the harness', async () => {
    const { service, harness, sessionRowCount } = setup();

    await expect(service.create({ ...SPEC, projectId: newId() })).rejects.toThrow(ProjectNotFoundError);

    expect(sessionRowCount()).toBe(0);
    expect(harness.launches).toEqual([]);
  });

  it('refuses an unknown project before creating a git worktree', async () => {
    const { service, worktreesRoot, sessionRowCount } = setup();
    const repoPath = makeRepo();

    await expect(service.createInWorktree({ ...SPEC, directory: repoPath, repoPath, branchName: 'task/link', projectId: newId() })).rejects.toThrow(ProjectNotFoundError);

    expect(existsSync(worktreesRoot)).toBe(false);
    expect(sessionRowCount()).toBe(0);
  });

  it('keeps the project through a worktree session', async () => {
    const { service, aProject } = setup();
    const projectId = aProject();
    const repoPath = makeRepo();

    const session = await service.createInWorktree({ ...SPEC, directory: repoPath, repoPath, branchName: 'task/link-ok', projectId });

    expect(session.projectId).toBe(projectId);
  });

  it('keeps the project when a closed session is reopened', async () => {
    const { service, harness, aProject } = setup();
    const projectId = aProject();
    const session = await service.create({ ...SPEC, projectId });
    harness.markPrompted(session.id);
    harness.handles[0]!.emitExit(0);

    const reopened = service.reopen(session.id);

    expect(reopened.projectId).toBe(projectId);
    expect(service.get(session.id)?.projectId).toBe(projectId);
  });
});
