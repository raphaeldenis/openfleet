import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaleWorktreeCleanup, StaleWorktreeItem } from '@openfleet/shared';
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
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { ProjectService } from '../projects/projectService.js';
import { SessionService } from '../sessions/sessionService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { WorktreeService } from '../worktrees/worktreeService.js';
import { startServer } from './server.js';

const CLOCK = '2026-10-28T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let worktreesRoot: string;
let gitCallLog: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' });

const call = (method: string, path: string) => fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
const cleanup = async (projectId: string, query = ''): Promise<StaleWorktreeCleanup> =>
  (await (await call('POST', `/api/projects/${projectId}/worktrees/stale-cleanup${query}`)).json()) as StaleWorktreeCleanup;
const itemOf = (result: StaleWorktreeCleanup, worktree: string): StaleWorktreeItem | undefined => result.items.find((item) => item.path === worktree);

/** A git wrapper on the PATH that records every argument it receives, one per line, then runs the real git. */
function installRecordingGit(): NodeJS.ProcessEnv {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const binDirectory = tempDirs.make('of-recording-git-');
  const wrapper = join(binDirectory, 'git');
  writeFileSync(wrapper, `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument"; done >> '${gitCallLog}'\nexec '${realGit}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  return { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` };
}

interface Project { projectId: string; repoPath: string }
let project: Project;

const aRepositoryWithARemote = (): string => {
  const repoPath = realpathSync(makeRepo());
  const remote = realpathSync(tempDirs.make('of-remote-'));
  git(remote, 'init', '--bare', '-b', 'main');
  git(repoPath, 'remote', 'add', 'origin', remote);
  git(repoPath, 'push', '-u', 'origin', 'main');
  return repoPath;
};
const aWorktree = async (branchName: string): Promise<string> =>
  realpathSync((await createWorktree({ repoPath: project.repoPath, branchName, worktreesRoot })).path);
const aPushedWorktree = async (branchName: string): Promise<string> => {
  const worktree = await aWorktree(branchName);
  git(worktree, 'push', '-u', 'origin', branchName);
  return worktree;
};

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  worktreesRoot = realpathSync(tempDirs.make('of-wt-stale-'));
  gitCallLog = join(tempDirs.make('of-git-log-'), 'calls.log');
  writeFileSync(gitCallLog, '');
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, clock: () => CLOCK, newId });
  const worktrees = new WorktreeService({ projects, sessions, worktreesRoot, env: installRecordingGit() });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService, worktrees,
  });
  const projectId = ((await (await fetch(`${server.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ name: 'Fleet' }),
  })).json()) as { id: string }).id;
  const repoPath = aRepositoryWithARemote();
  await sessions.create({ directory: repoPath, name: 'Main session', harness: 'fake', emoji: '🤖', projectId });
  project = { projectId, repoPath };
});
afterEach(async () => {
  await sessions.closeAll();
  await server.close();
  tempDirs.removeAll();
});

describe('POST /api/projects/:id/worktrees/stale-cleanup', () => {
  it('proposes a clean worktree whose branch is entirely on the remote, and removes nothing by default', async () => {
    const pushed = await aPushedWorktree('task/pushed');

    const result = await cleanup(project.projectId);

    expect(result.applied).toBe(false);
    expect(itemOf(result, pushed)).toMatchObject({ branch: 'task/pushed', reason: 'fully_pushed', eligible: true, outcome: 'proposed' });
    expect(result.removed).toEqual([]);
    expect(existsSync(pushed)).toBe(true);
  });

  it('flags a worktree holding a commit that is not pushed, and never removes it', async () => {
    const worktree = await aPushedWorktree('task/ahead');
    writeFileSync(join(worktree, 'local.txt'), 'x');
    git(worktree, 'add', 'local.txt');
    git(worktree, 'commit', '-m', 'local only');

    const result = await cleanup(project.projectId, '?apply=true');

    expect(itemOf(result, worktree)).toMatchObject({ reason: 'unpushed_commits', eligible: false, outcome: 'kept' });
    expect(existsSync(worktree)).toBe(true);
  });

  it.each([
    ['an untracked file', (worktree: string) => writeFileSync(join(worktree, 'new.txt'), 'x')],
    ['a modified tracked file', (worktree: string) => writeFileSync(join(worktree, 'tracked.txt'), 'changed')],
  ])('flags a pushed worktree with %s as dirty, and never removes it', async (_name, makeDirty) => {
    const worktree = await aWorktree('task/dirty');
    writeFileSync(join(worktree, 'tracked.txt'), 'original');
    git(worktree, 'add', 'tracked.txt');
    git(worktree, 'commit', '-m', 'add tracked');
    git(worktree, 'push', '-u', 'origin', 'task/dirty');
    makeDirty(worktree);

    const result = await cleanup(project.projectId, '?apply=true');

    expect(itemOf(result, worktree)).toMatchObject({ reason: 'dirty', eligible: false, outcome: 'kept' });
    expect(existsSync(worktree)).toBe(true);
  });

  it('flags a branch without an upstream, and never removes it', async () => {
    const worktree = await aWorktree('task/local-only');

    const result = await cleanup(project.projectId, '?apply=true');

    expect(itemOf(result, worktree)).toMatchObject({ reason: 'no_upstream', eligible: false, outcome: 'kept' });
    expect(existsSync(worktree)).toBe(true);
  });

  it('flags a branch whose upstream is a local branch, and never removes it', async () => {
    const worktree = await aWorktree('task/tracks-local');
    git(worktree, 'branch', '--set-upstream-to=main');

    const result = await cleanup(project.projectId, '?apply=true');

    expect(itemOf(result, worktree)).toMatchObject({ reason: 'no_upstream', eligible: false, outcome: 'kept' });
    expect(existsSync(worktree)).toBe(true);
  });

  it('flags a branch whose remote branch is gone, and never removes it', async () => {
    const worktree = await aPushedWorktree('task/remote-gone');
    git(project.repoPath, 'update-ref', '-d', 'refs/remotes/origin/task/remote-gone');

    const result = await cleanup(project.projectId, '?apply=true');

    expect(itemOf(result, worktree)).toMatchObject({ reason: 'no_upstream', eligible: false });
    expect(existsSync(worktree)).toBe(true);
  });

  it('does not list the main worktree', async () => {
    const result = await cleanup(project.projectId);

    expect(result.items.map((item) => item.path)).not.toContain(project.repoPath);
  });

  it.each(['?apply=false', '?apply=1', '?apply=yes', '?apply='])('stays a dry run for %s', async (query) => {
    const pushed = await aPushedWorktree('task/dry');

    const result = await cleanup(project.projectId, query);

    expect(result.applied).toBe(false);
    expect(existsSync(pushed)).toBe(true);
  });

  it('removes only the fully pushed worktrees with ?apply=true and keeps every branch', async () => {
    const pushed = await aPushedWorktree('task/pushed');
    const unpushed = await aWorktree('task/unpushed');
    const dirty = await aPushedWorktree('task/dirty');
    writeFileSync(join(dirty, 'wip.txt'), 'x');

    const result = await cleanup(project.projectId, '?apply=true');

    expect(result.applied).toBe(true);
    expect(itemOf(result, pushed)).toMatchObject({ eligible: true, outcome: 'removed' });
    expect(result.removed.map((removed) => removed.removed)).toEqual([pushed]);
    expect(existsSync(pushed)).toBe(false);
    expect(existsSync(unpushed)).toBe(true);
    expect(existsSync(dirty)).toBe(true);
    const branches = git(project.repoPath, 'branch', '--list');
    expect(branches).toContain('task/pushed');
    expect(branches).toContain('task/unpushed');
    expect(branches).toContain('task/dirty');
  });

  it('never passes --force to git, whichever way the request goes', async () => {
    await aPushedWorktree('task/pushed');
    await aWorktree('task/unpushed');

    await cleanup(project.projectId);
    await cleanup(project.projectId, '?apply=true');

    const gitArguments = readFileSync(gitCallLog, 'utf8').split('\n');
    expect(gitArguments).toContain('remove');
    expect(gitArguments.filter((argument) => argument === '--force' || argument === '-f' || argument === '-ff')).toEqual([]);
  });

  it('answers 404 project_not_found for an unknown project', async () => {
    const res = await call('POST', '/api/projects/00000000-0000-4000-8000-000000000000/worktrees/stale-cleanup?apply=true');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'project_not_found' });
  });

  it('needs the admin token', async () => {
    const pushed = await aPushedWorktree('task/pushed');

    const res = await fetch(`${server.url}/api/projects/${project.projectId}/worktrees/stale-cleanup?apply=true`, { method: 'POST' });

    expect(res.status).toBe(401);
    expect(existsSync(pushed)).toBe(true);
  });
});
