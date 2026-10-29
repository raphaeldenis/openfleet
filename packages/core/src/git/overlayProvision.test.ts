import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { makeRepo } from './testRepo.js';
import { provideOverlay } from './overlayProvision.js';
import { createWorktreeWithHook, overlayOf } from './worktreeCreation.js';

const OVERLAY_LINK_NAME = '.openfleet-overlay';
const MARKER_START = '# >>> openfleet overlay (managed)';
const tempDirs = createTempDirTracker();
const repos: string[] = [];

afterEach(() => {
  tempDirs.removeAll();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' });

function aRepo(): string {
  const repo = realpathSync(makeRepo());
  repos.push(repo);
  return repo;
}

const excludeFileOf = (repo: string): string => git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude').trim();
const occurrencesOf = (text: string, needle: string): number => text.split(needle).length - 1;

function aSharedRepoSetup() {
  const repo = aRepo();
  const overlayDirectory = join(realpathSync(tempDirs.make('of-overlay-')), 'overlays', 'p1');
  const createIn = (branchName: string, overlay: { directory: string } | null = { directory: overlayDirectory }) =>
    createWorktreeWithHook({ repoPath: repo, branchName, worktreesRoot: realpathSync(tempDirs.make('of-overlay-wt-')), ...(overlay ? { overlay } : {}) });
  return { repo, overlayDirectory, createIn };
}

describe('createWorktreeWithHook on a project whose repository is shared', () => {
  it('links the overlay directory into the worktree and creates the directory', async () => {
    const { overlayDirectory, createIn } = aSharedRepoSetup();

    const { path } = await createIn('task/a');

    expect(lstatSync(join(path, OVERLAY_LINK_NAME)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, OVERLAY_LINK_NAME))).toBe(overlayDirectory);
    expect(existsSync(overlayDirectory)).toBe(true);
  });

  it('keeps what the fleet writes in the overlay out of git status, in the worktree and in the main checkout', async () => {
    const { repo, createIn } = aSharedRepoSetup();
    const { path } = await createIn('task/a');

    writeFileSync(join(path, OVERLAY_LINK_NAME, 'run-tests.sh'), 'echo ok\n');

    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('writes one marked block in the exclude file of the common git directory, however many worktrees are created', async () => {
    const { repo, createIn } = aSharedRepoSetup();

    await createIn('task/a');
    await createIn('task/b');

    const exclude = readFileSync(excludeFileOf(repo), 'utf8');
    expect(occurrencesOf(exclude, MARKER_START)).toBe(1);
    expect(exclude).toContain(`/${OVERLAY_LINK_NAME}`);
  });

  it('keeps the lines already in the exclude file', async () => {
    const { repo, createIn } = aSharedRepoSetup();
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(excludeFileOf(repo), '# mine\n*.log\n');

    await createIn('task/a');

    expect(readFileSync(excludeFileOf(repo), 'utf8')).toMatch(/^# mine\n\*\.log\n/);
  });

  it('answers an overlay_unavailable warning and leaves the exclude file alone when the overlay directory cannot be created', async () => {
    const { repo, createIn } = aSharedRepoSetup();
    const excludeBefore = existsSync(excludeFileOf(repo)) ? readFileSync(excludeFileOf(repo), 'utf8') : '';
    const aFile = join(tempDirs.make('of-overlay-blocker-'), 'file');
    writeFileSync(aFile, 'not a directory');

    const created = await createIn('task/a', { directory: join(aFile, 'overlays', 'p1') });

    expect(created.warnings).toEqual([{ type: 'overlay_unavailable' }]);
    expect(existsSync(created.path)).toBe(true);
    const excludeAfter = existsSync(excludeFileOf(repo)) ? readFileSync(excludeFileOf(repo), 'utf8') : '';
    expect(excludeAfter).toBe(excludeBefore);
  });
});

describe('provideOverlay on a worktree that already has a .openfleet-overlay', () => {
  const overlayDirectoryOf = () => join(realpathSync(tempDirs.make('of-overlay-')), 'overlays', 'p1');

  it('answers no warning when the existing link already points to the overlay', async () => {
    const worktreePath = aRepo();
    const overlayDirectory = overlayDirectoryOf();
    await provideOverlay({ overlayDirectory, worktreePath });

    expect(await provideOverlay({ overlayDirectory, worktreePath })).toBeUndefined();
  });

  it('answers an overlay_unavailable warning when the existing entry is a regular file', async () => {
    const worktreePath = aRepo();
    writeFileSync(join(worktreePath, OVERLAY_LINK_NAME), 'tracked by the team');

    expect(await provideOverlay({ overlayDirectory: overlayDirectoryOf(), worktreePath })).toEqual({ type: 'overlay_unavailable' });
  });

  it('answers an overlay_unavailable warning when the existing link points elsewhere', async () => {
    const worktreePath = aRepo();
    symlinkSync(realpathSync(tempDirs.make('of-overlay-elsewhere-')), join(worktreePath, OVERLAY_LINK_NAME), 'dir');

    expect(await provideOverlay({ overlayDirectory: overlayDirectoryOf(), worktreePath })).toEqual({ type: 'overlay_unavailable' });
  });

  it('creates the overlay directory readable by its owner only', async () => {
    const overlayDirectory = overlayDirectoryOf();

    await provideOverlay({ overlayDirectory, worktreePath: aRepo() });

    expect(statSync(overlayDirectory).mode & 0o777).toBe(0o700);
  });
});

describe('createWorktreeWithHook on a project whose repository is not shared', () => {
  it('writes nothing: no overlay directory, no link, no exclude block', async () => {
    const { repo, overlayDirectory, createIn } = aSharedRepoSetup();

    const { path } = await createIn('task/a', null);

    expect(existsSync(overlayDirectory)).toBe(false);
    expect(existsSync(join(path, OVERLAY_LINK_NAME))).toBe(false);
    const exclude = existsSync(excludeFileOf(repo)) ? readFileSync(excludeFileOf(repo), 'utf8') : '';
    expect(exclude).not.toContain(MARKER_START);
  });
});

describe('overlayOf', () => {
  const project = { id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' };

  it('places the overlay of a shared project next to the worktrees root, under the project id', () => {
    expect(overlayOf({ ...project, sharedRepo: true }, '/home/of/worktrees')).toEqual({ directory: '/home/of/overlays/p1' });
  });

  it('gives no overlay to a project that does not share its repository, nor to a session without project', () => {
    expect(overlayOf(project, '/home/of/worktrees')).toBeUndefined();
    expect(overlayOf(undefined, '/home/of/worktrees')).toBeUndefined();
  });
});
