import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenFleetError } from '@openfleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { makeRepo } from './testRepo.js';
import { listRepoWorktrees, removeWorktree } from './worktreeInventory.js';
import { createWorktree } from './worktrees.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const gitEnv = childEnvironmentForGit(process.env);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { cwd, env: gitEnv, encoding: 'utf8' });

interface Fixture { repoPath: string; worktreesRoot: string }
const aFixture = (): Fixture => ({ repoPath: realpathSync(makeRepo()), worktreesRoot: realpathSync(tempDirs.make('of-wt-root-')) });
const aWorktree = async (fixture: Fixture, branchName: string): Promise<string> => {
  const created = await createWorktree({ repoPath: fixture.repoPath, branchName, worktreesRoot: fixture.worktreesRoot });
  return realpathSync(created.path);
};
const worktreePathsOf = (repoPath: string): string[] =>
  git(repoPath, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
const entryFor = async (fixture: Fixture, path: string) => (await listRepoWorktrees(fixture)).find((entry) => entry.path === path);

async function expectRefusal(removal: Promise<unknown>, reason: string): Promise<void> {
  const refusal = await removal.then(() => undefined, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(OpenFleetError);
  expect(refusal).toMatchObject({ code: 'constraint_violation', options: { detail: { reason } } });
}

describe('listRepoWorktrees', () => {
  it('lists the main worktree first, then the linked ones, with branch, head and the root they live under', async () => {
    const fixture = aFixture();
    const linked = await aWorktree(fixture, 'task/one');

    const entries = await listRepoWorktrees(fixture);

    expect(entries.map((entry) => entry.path)).toEqual([fixture.repoPath, linked]);
    expect(entries[0]).toMatchObject({ repoPath: fixture.repoPath, branch: 'main', isMain: true, isUnderWorktreesRoot: false, isDetached: false, isLocked: false, isDirty: false });
    expect(entries[1]).toMatchObject({ branch: 'task/one', isMain: false, isUnderWorktreesRoot: true, isDetached: false, isLocked: false, isDirty: false });
    expect(entries[1]!.head).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('flags a detached HEAD, a locked worktree and an untracked file', async () => {
    const fixture = aFixture();
    const detached = await aWorktree(fixture, 'task/detached');
    git(detached, 'checkout', '--detach');
    const locked = await aWorktree(fixture, 'task/locked');
    git(fixture.repoPath, 'worktree', 'lock', '--reason', 'in use elsewhere', locked);
    const dirty = await aWorktree(fixture, 'task/dirty');
    writeFileSync(join(dirty, 'notes.txt'), 'wip\n');

    expect(await entryFor(fixture, detached)).toMatchObject({ branch: null, isDetached: true });
    expect(await entryFor(fixture, locked)).toMatchObject({ isLocked: true });
    expect(await entryFor(fixture, dirty)).toMatchObject({ isDirty: true });
  });

  it('does not call a worktree dirty because of ignored files only', async () => {
    const fixture = aFixture();
    writeFileSync(join(fixture.repoPath, '.gitignore'), 'node_modules/\n.env\n');
    git(fixture.repoPath, 'add', '.gitignore');
    git(fixture.repoPath, 'commit', '-m', 'ignore');
    const worktree = await aWorktree(fixture, 'task/ignored');
    mkdirSync(join(worktree, 'node_modules'));
    writeFileSync(join(worktree, 'node_modules', 'dep.js'), 'x');
    writeFileSync(join(worktree, '.env'), 'SECRET=1');

    expect(await entryFor(fixture, worktree)).toMatchObject({ isDirty: false });
  });

  it('flags a worktree whose directory is gone as prunable', async () => {
    const fixture = aFixture();
    const worktree = await aWorktree(fixture, 'task/gone');
    rmSync(worktree, { recursive: true, force: true });

    expect(await entryFor(fixture, worktree)).toMatchObject({ isPrunable: true });
  });

  it('answers an empty list for a directory that is not a git repository', async () => {
    const notARepository = tempDirs.make('of-not-a-repo-');

    expect(await listRepoWorktrees({ repoPath: notARepository, worktreesRoot: tempDirs.make('of-wt-root-') })).toEqual([]);
  });
});

describe('removeWorktree', () => {
  it('removes a clean worktree directory and its git entry, and keeps the branch', async () => {
    const fixture = aFixture();
    const worktree = await aWorktree(fixture, 'task/clean');

    const result = await removeWorktree({ ...fixture, worktreePath: worktree });

    expect(result).toEqual({ removed: worktree, branch: 'task/clean', ignoredFileCount: 0 });
    expect(existsSync(worktree)).toBe(false);
    expect(worktreePathsOf(fixture.repoPath)).toEqual([fixture.repoPath]);
    expect(git(fixture.repoPath, 'branch', '--list', 'task/clean').trim()).toContain('task/clean');
  });

  it('removes a worktree that holds ignored files only, and says how many ignored files went with it', async () => {
    const fixture = aFixture();
    writeFileSync(join(fixture.repoPath, '.gitignore'), 'node_modules/\n.env\n');
    git(fixture.repoPath, 'add', '.gitignore');
    git(fixture.repoPath, 'commit', '-m', 'ignore');
    const worktree = await aWorktree(fixture, 'task/ignored');
    mkdirSync(join(worktree, 'node_modules'));
    writeFileSync(join(worktree, 'node_modules', 'a.js'), 'x');
    writeFileSync(join(worktree, 'node_modules', 'b.js'), 'x');
    writeFileSync(join(worktree, '.env'), 'SECRET=1');

    const result = await removeWorktree({ ...fixture, worktreePath: worktree });

    expect(result.ignoredFileCount).toBe(3);
    expect(existsSync(worktree)).toBe(false);
  });

  it('lets the same branch come back through createWorktree after its worktree was removed', async () => {
    const fixture = aFixture();
    const worktree = await aWorktree(fixture, 'task/again');
    writeFileSync(join(worktree, 'kept.txt'), 'x');
    git(worktree, 'add', 'kept.txt');
    git(worktree, 'commit', '-m', 'work');
    await removeWorktree({ ...fixture, worktreePath: worktree });

    const again = await aWorktree(fixture, 'task/again');

    expect(existsSync(join(again, 'kept.txt'))).toBe(true);
  });

  describe('refuses, leaves the worktree and the branch untouched, and says why', () => {
    const expectUntouched = (fixture: Fixture, worktree: string, pathsBefore: string[]): void => {
      expect(existsSync(worktree)).toBe(true);
      expect(worktreePathsOf(fixture.repoPath)).toEqual(pathsBefore);
    };

    it('an untracked file: dirty', async () => {
      const fixture = aFixture();
      const worktree = await aWorktree(fixture, 'task/untracked');
      writeFileSync(join(worktree, 'new.txt'), 'x');
      const pathsBefore = worktreePathsOf(fixture.repoPath);

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: worktree }), 'dirty');

      expectUntouched(fixture, worktree, pathsBefore);
      expect(existsSync(join(worktree, 'new.txt'))).toBe(true);
    });

    it('a modified tracked file: dirty', async () => {
      const fixture = aFixture();
      writeFileSync(join(fixture.repoPath, 'tracked.txt'), 'one\n');
      git(fixture.repoPath, 'add', 'tracked.txt');
      git(fixture.repoPath, 'commit', '-m', 'tracked');
      const worktree = await aWorktree(fixture, 'task/modified');
      writeFileSync(join(worktree, 'tracked.txt'), 'two\n');

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: worktree }), 'dirty');

      expect(existsSync(worktree)).toBe(true);
    });

    it('a staged file: dirty', async () => {
      const fixture = aFixture();
      const worktree = await aWorktree(fixture, 'task/staged');
      writeFileSync(join(worktree, 'staged.txt'), 'x');
      git(worktree, 'add', 'staged.txt');

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: worktree }), 'dirty');

      expect(existsSync(worktree)).toBe(true);
    });

    it('a detached HEAD: detached', async () => {
      const fixture = aFixture();
      const worktree = await aWorktree(fixture, 'task/detach');
      git(worktree, 'checkout', '--detach');
      const pathsBefore = worktreePathsOf(fixture.repoPath);

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: worktree }), 'detached');

      expectUntouched(fixture, worktree, pathsBefore);
    });

    it('a locked worktree: locked', async () => {
      const fixture = aFixture();
      const worktree = await aWorktree(fixture, 'task/lock');
      git(fixture.repoPath, 'worktree', 'lock', worktree);
      const pathsBefore = worktreePathsOf(fixture.repoPath);

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: worktree }), 'locked');

      expectUntouched(fixture, worktree, pathsBefore);
    });

    it('the main worktree: main', async () => {
      const fixture = aFixture();
      await aWorktree(fixture, 'task/other');

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: fixture.repoPath }), 'main');

      expect(existsSync(join(fixture.repoPath, '.git'))).toBe(true);
    });

    it('a worktree outside the worktrees root: outside_root', async () => {
      const fixture = aFixture();
      const elsewhere = join(realpathSync(tempDirs.make('of-elsewhere-')), 'handmade');
      git(fixture.repoPath, 'worktree', 'add', '-b', 'handmade', elsewhere);
      const pathsBefore = worktreePathsOf(fixture.repoPath);

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: elsewhere }), 'outside_root');

      expectUntouched(fixture, elsewhere, pathsBefore);
    });

    it('a worktree that holds a submodule: submodules', async () => {
      const fixture = aFixture();
      const library = realpathSync(makeRepo());
      git(fixture.repoPath, 'submodule', 'add', library, 'lib');
      git(fixture.repoPath, 'commit', '-m', 'add submodule');
      const worktree = await aWorktree(fixture, 'task/submodule');
      git(worktree, 'submodule', 'update', '--init');
      const pathsBefore = worktreePathsOf(fixture.repoPath);

      await expectRefusal(removeWorktree({ ...fixture, worktreePath: worktree }), 'submodules');

      expectUntouched(fixture, worktree, pathsBefore);
    });

    it('a path that is not a worktree of the repository: not_found, and nothing is deleted', async () => {
      const fixture = aFixture();
      const stranger = join(fixture.worktreesRoot, 'not-a-worktree');
      mkdirSync(stranger);
      writeFileSync(join(stranger, 'precious.txt'), 'x');

      const refusal = await removeWorktree({ ...fixture, worktreePath: stranger }).then(() => undefined, (error: unknown) => error);

      expect(refusal).toBeInstanceOf(OpenFleetError);
      expect(refusal).toMatchObject({ code: 'not_found' });
      expect(existsSync(join(stranger, 'precious.txt'))).toBe(true);
    });

    it('a worktree that turns dirty after the checks: git refuses and the new file survives (no --force)', async () => {
      const fixture = aFixture();
      const worktree = await aWorktree(fixture, 'task/race');

      const removal = removeWorktree({ ...fixture, worktreePath: worktree, afterChecks: () => writeFileSync(join(worktree, 'late.txt'), 'x') });

      await expectRefusal(removal, 'removal_refused');
      expect(existsSync(join(worktree, 'late.txt'))).toBe(true);
      expect(git(fixture.repoPath, 'branch', '--list', 'task/race').trim()).toContain('task/race');
    });
  });

  it('matches the worktree through a symlinked spelling of its path', async () => {
    const fixture = aFixture();
    const worktree = await aWorktree(fixture, 'task/symlink');
    const alias = join(tempDirs.make('of-alias-'), 'alias');
    symlinkSync(worktree, alias);

    const result = await removeWorktree({ ...fixture, worktreePath: alias });

    expect(result.removed).toBe(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  it('removes a worktree whose directory name has spaces and shell metacharacters without running anything', async () => {
    const fixture = aFixture();
    const hostile = join(fixture.worktreesRoot, 'a b $(touch pwned) `id`;x');
    git(fixture.repoPath, 'worktree', 'add', '-b', 'hostile', hostile);

    const result = await removeWorktree({ ...fixture, worktreePath: hostile });

    expect(result.branch).toBe('hostile');
    expect(existsSync(hostile)).toBe(false);
    expect(existsSync(join(fixture.repoPath, 'pwned'))).toBe(false);
    expect(existsSync(join(fixture.worktreesRoot, 'pwned'))).toBe(false);
  });
});
