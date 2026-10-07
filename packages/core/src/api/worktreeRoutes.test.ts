import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorEnvelope, RemovedWorktree, WorktreeEntry, WorktreeList } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { createWorktree } from '../git/worktrees.js';
import { makeRepo } from '../git/testRepo.js';
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
import { WorktreeService } from '../worktrees/worktreeService.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { startServer } from './server.js';

const CLOCK = '2026-10-07T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let worktreesRoot: string;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const createProject = async (name = 'Fleet'): Promise<string> => ((await (await call('POST', '/api/projects', { name })).json()) as { id: string }).id;
const listWorktrees = (projectId: string, query = '') => call('GET', `/api/projects/${projectId}/worktrees${query}`);
const removeWorktreeAt = (projectId: string, path: string) => call('DELETE', `/api/projects/${projectId}/worktrees?path=${encodeURIComponent(path)}`);
const listedOf = async (projectId: string, query = ''): Promise<WorktreeEntry[]> => ((await (await listWorktrees(projectId, query)).json()) as WorktreeList).items;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' });

const aRepository = (): string => realpathSync(makeRepo());
const aWorktreeOf = async (repoPath: string, branchName: string): Promise<string> =>
  realpathSync((await createWorktree({ repoPath, branchName, worktreesRoot })).path);
const sessionIn = (directory: string, projectId: string | undefined) =>
  sessions.create({ directory, name: `Session in ${directory.slice(-12)}`, harness: 'fake', emoji: '🤖', projectId });

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  worktreesRoot = realpathSync(tempDirs.make('of-wt-routes-'));
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, clock: () => CLOCK, newId });
  const worktrees = new WorktreeService({ projects, sessions, worktreesRoot });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService, worktrees,
  });
});
afterEach(async () => {
  await sessions.closeAll();
  await server.close();
  tempDirs.removeAll();
});

describe('GET /api/projects/:id/worktrees', () => {
  it('answers 404 project_not_found for an unknown project', async () => {
    const res = await listWorktrees('00000000-0000-4000-8000-000000000000');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'project_not_found' });
  });

  it('answers an empty list for a project none of whose sessions is in a git repository', async () => {
    const projectId = await createProject();
    await sessionIn(tempDirs.make('of-not-a-repo-'), projectId);

    const res = await listWorktrees(projectId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0 });
  });

  it('lists the worktrees of the repository of the project sessions, the main one first, once however many sessions live there', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    const linked = await aWorktreeOf(repoPath, 'task/one');
    await sessionIn(repoPath, projectId);
    await sessionIn(repoPath, projectId);

    const res = await listWorktrees(projectId);

    expect(res.status).toBe(200);
    const list = (await res.json()) as WorktreeList;
    expect(list.total).toBe(2);
    expect(list.items.map((entry) => entry.path)).toEqual([repoPath, linked]);
    expect(list.items[0]).toMatchObject({ repoPath, branch: 'main', isMain: true, removable: false, notRemovableReason: 'main' });
    expect(list.items[1]).toMatchObject({ repoPath, branch: 'task/one', isMain: false, isDirty: false, isUnderWorktreesRoot: true, isInUse: false, removable: true });
    expect(list.items[1]).not.toHaveProperty('notRemovableReason');
  });

  it('lists nothing from the repositories of another project', async () => {
    const projectId = await createProject('Fleet');
    const otherProjectId = await createProject('Other');
    const repoPath = aRepository();
    const otherRepoPath = aRepository();
    await sessionIn(repoPath, projectId);
    await sessionIn(otherRepoPath, otherProjectId);

    expect((await listedOf(projectId)).map((entry) => entry.repoPath)).toEqual([repoPath]);
    expect((await listedOf(otherProjectId)).map((entry) => entry.repoPath)).toEqual([otherRepoPath]);
  });

  it('marks a worktree used by a live session as in use, with that session, and not removable', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    const linked = await aWorktreeOf(repoPath, 'task/busy');
    const session = await sessionIn(linked, projectId);

    const entry = (await listedOf(projectId)).find((candidate) => candidate.path === linked);

    expect(entry).toMatchObject({ isInUse: true, inUseBySessionId: session.id, removable: false, notRemovableReason: 'in_use' });
  });

  it('counts a session working in a subdirectory of the worktree as using it', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    const linked = await aWorktreeOf(repoPath, 'task/sub');
    mkdirSync(join(linked, 'packages'));
    await sessionIn(repoPath, projectId);
    const subdirectorySession = await sessionIn(join(linked, 'packages'), projectId);

    const entry = (await listedOf(projectId)).find((candidate) => candidate.path === linked);

    expect(entry).toMatchObject({ isInUse: true, inUseBySessionId: subdirectorySession.id });
  });

  it('does not count a closed session as using the worktree', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    const linked = await aWorktreeOf(repoPath, 'task/done');
    await sessionIn(repoPath, projectId);
    const session = await sessionIn(linked, projectId);
    await sessions.close(session.id);

    const entry = (await listedOf(projectId)).find((candidate) => candidate.path === linked);

    expect(entry).toMatchObject({ isInUse: false, removable: true });
  });

  it('flags dirty, detached and locked worktrees with their reason', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    await sessionIn(repoPath, projectId);
    const dirty = await aWorktreeOf(repoPath, 'task/dirty');
    writeFileSync(join(dirty, 'wip.txt'), 'x');
    const detached = await aWorktreeOf(repoPath, 'task/detached');
    git(detached, 'checkout', '--detach');
    const locked = await aWorktreeOf(repoPath, 'task/locked');
    git(repoPath, 'worktree', 'lock', locked);

    const entries = await listedOf(projectId);
    const reasonOf = (path: string) => entries.find((entry) => entry.path === path)?.notRemovableReason;

    expect(reasonOf(dirty)).toBe('dirty');
    expect(reasonOf(detached)).toBe('detached');
    expect(reasonOf(locked)).toBe('locked');
  });

  it('flags a worktree outside the worktrees root as not removable', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    await sessionIn(repoPath, projectId);
    const handmade = join(realpathSync(tempDirs.make('of-handmade-')), 'handmade');
    git(repoPath, 'worktree', 'add', '-b', 'handmade', handmade);

    const entry = (await listedOf(projectId)).find((candidate) => candidate.branch === 'handmade');

    expect(entry).toMatchObject({ isUnderWorktreesRoot: false, removable: false, notRemovableReason: 'outside_root' });
  });

  describe('search with ?q=', () => {
    it('keeps the worktrees whose repository, branch or path holds the text, in any case', async () => {
      const projectId = await createProject();
      const repoPath = aRepository();
      await sessionIn(repoPath, projectId);
      const alpha = await aWorktreeOf(repoPath, 'feature/Alpha-search');
      await aWorktreeOf(repoPath, 'bugfix/beta');

      expect((await listedOf(projectId, '?q=ALPHA')).map((entry) => entry.path)).toEqual([alpha]);
      expect((await listedOf(projectId, '?q=bugfix')).map((entry) => entry.branch)).toEqual(['bugfix/beta']);
      expect((await listedOf(projectId, `?q=${encodeURIComponent(repoPath.slice(-10))}`)).length).toBe(3);
      expect((await listedOf(projectId, '?q=nothing-matches-this')).length).toBe(0);
    });

    it('answers the matching count as total', async () => {
      const projectId = await createProject();
      const repoPath = aRepository();
      await sessionIn(repoPath, projectId);
      await aWorktreeOf(repoPath, 'feature/one');
      await aWorktreeOf(repoPath, 'feature/two');

      const list = (await (await listWorktrees(projectId, '?q=feature')).json()) as WorktreeList;

      expect(list.total).toBe(2);
    });
  });
});

describe('DELETE /api/projects/:id/worktrees', () => {
  const projectWithAWorktree = async (branchName = 'task/clean') => {
    const projectId = await createProject();
    const repoPath = aRepository();
    await sessionIn(repoPath, projectId);
    const worktree = await aWorktreeOf(repoPath, branchName);
    return { projectId, repoPath, worktree };
  };

  it('removes a clean worktree, keeps its branch and says what it removed', async () => {
    const { projectId, repoPath, worktree } = await projectWithAWorktree();

    const res = await removeWorktreeAt(projectId, worktree);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: worktree, branch: 'task/clean', ignoredFileCount: 0 } satisfies RemovedWorktree);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repoPath, 'branch', '--list', 'task/clean')).toContain('task/clean');
    expect((await listedOf(projectId)).map((entry) => entry.path)).toEqual([repoPath]);
  });

  it('refuses a worktree used by a live session with 409 directory_in_use and removes nothing', async () => {
    const { projectId, worktree } = await projectWithAWorktree('task/busy');
    await sessionIn(worktree, projectId);

    const res = await removeWorktreeAt(projectId, worktree);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'directory_in_use', kind: 'conflict', retry: 'never', detail: { reason: 'in_use' } });
    expect(existsSync(worktree)).toBe(true);
  });

  it('refuses a worktree a session works in a subdirectory of', async () => {
    const { projectId, worktree } = await projectWithAWorktree('task/subdir');
    mkdirSync(join(worktree, 'src'));
    await sessionIn(join(worktree, 'src'), projectId);

    const res = await removeWorktreeAt(projectId, worktree);

    expect(res.status).toBe(409);
    expect(existsSync(worktree)).toBe(true);
  });

  it('removes a worktree whose session is closed', async () => {
    const { projectId, worktree } = await projectWithAWorktree('task/closed');
    const session = await sessionIn(worktree, projectId);
    await sessions.close(session.id);

    const res = await removeWorktreeAt(projectId, worktree);

    expect(res.status).toBe(200);
    expect(existsSync(worktree)).toBe(false);
  });

  it.each([
    ['dirty', (_repoPath: string, worktree: string) => writeFileSync(join(worktree, 'wip.txt'), 'x')],
    ['detached', (_repoPath: string, worktree: string) => git(worktree, 'checkout', '--detach')],
    ['locked', (repoPath: string, worktree: string) => git(repoPath, 'worktree', 'lock', worktree)],
  ])('refuses a %s worktree with 400 constraint_violation and its reason, and keeps it', async (reason, makeUnsafe) => {
    const { projectId, repoPath, worktree } = await projectWithAWorktree(`task/${reason}`);
    makeUnsafe(repoPath, worktree);

    const res = await removeWorktreeAt(projectId, worktree);

    expect(res.status).toBe(400);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope).toMatchObject({ error: 'constraint_violation', kind: 'invalid_request', detail: { reason } });
    expect(JSON.stringify(envelope)).not.toContain(worktree);
    expect(existsSync(worktree)).toBe(true);
  });

  it('refuses the main worktree of a repository', async () => {
    const { projectId, repoPath } = await projectWithAWorktree();

    const res = await removeWorktreeAt(projectId, repoPath);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'constraint_violation', detail: { reason: 'main' } });
    expect(existsSync(join(repoPath, '.git'))).toBe(true);
  });

  it('refuses a worktree outside the worktrees root', async () => {
    const { projectId, repoPath } = await projectWithAWorktree();
    const handmade = join(realpathSync(tempDirs.make('of-handmade-')), 'handmade');
    git(repoPath, 'worktree', 'add', '-b', 'handmade', handmade);

    const res = await removeWorktreeAt(projectId, handmade);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'constraint_violation', detail: { reason: 'outside_root' } });
    expect(existsSync(handmade)).toBe(true);
  });

  it('answers 404 not_found for a directory that is no worktree of the project, and deletes nothing', async () => {
    const { projectId } = await projectWithAWorktree();
    const stranger = join(worktreesRoot, 'stranger');
    mkdirSync(stranger);
    writeFileSync(join(stranger, 'precious.txt'), 'x');

    const res = await removeWorktreeAt(projectId, stranger);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
    expect(existsSync(join(stranger, 'precious.txt'))).toBe(true);
  });

  it('answers 404 not_found for a worktree that belongs to the repository of another project', async () => {
    const { projectId } = await projectWithAWorktree('task/mine');
    const otherProjectId = await createProject('Other');
    const otherRepo = aRepository();
    await sessionIn(otherRepo, otherProjectId);
    const foreign = await aWorktreeOf(otherRepo, 'task/foreign');

    const res = await removeWorktreeAt(projectId, foreign);

    expect(res.status).toBe(404);
    expect(existsSync(foreign)).toBe(true);
  });

  it('answers 404 project_not_found for an unknown project', async () => {
    const res = await removeWorktreeAt('00000000-0000-4000-8000-000000000000', '/tmp/anything');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'project_not_found' });
  });

  it.each([['no path', ''], ['a relative path', '?path=task-clean']])('refuses %s with 400 invalid_body', async (_name, query) => {
    const { projectId, worktree } = await projectWithAWorktree();

    const res = await call('DELETE', `/api/projects/${projectId}/worktrees${query}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(existsSync(worktree)).toBe(true);
  });

  it('says how many ignored files went with the worktree', async () => {
    const projectId = await createProject();
    const repoPath = aRepository();
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules/\n');
    git(repoPath, 'add', '.gitignore');
    git(repoPath, 'commit', '-m', 'ignore');
    await sessionIn(repoPath, projectId);
    const worktree = await aWorktreeOf(repoPath, 'task/ignored');
    mkdirSync(join(worktree, 'node_modules'));
    writeFileSync(join(worktree, 'node_modules', 'a.js'), 'x');
    writeFileSync(join(worktree, 'node_modules', 'b.js'), 'x');

    const res = await removeWorktreeAt(projectId, worktree);

    expect(await res.json()).toMatchObject({ removed: worktree, ignoredFileCount: 2 });
  });

  it('needs the admin token', async () => {
    const { projectId, worktree } = await projectWithAWorktree();

    const res = await fetch(`${server.url}/api/projects/${projectId}/worktrees?path=${encodeURIComponent(worktree)}`, { method: 'DELETE' });

    expect(res.status).toBe(401);
    expect(existsSync(worktree)).toBe(true);
  });
});
