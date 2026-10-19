import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { makeRepo } from './testRepo.js';
import { createWorktreeWithHook } from './worktreeCreation.js';

const HOOKS_PATH = '.husky/_';
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

function aRepoWithHooksPath(hooksPath = HOOKS_PATH): string {
  const repo = aRepo();
  git(repo, 'config', 'core.hooksPath', hooksPath);
  return repo;
}

function writeHook(directory: string, name: string, body: string): void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const createIn = (repoPath: string, branchName: string, extra: { hook?: { script: string; timeoutSeconds: number; projectId: string }; env?: NodeJS.ProcessEnv } = {}) =>
  createWorktreeWithHook({ repoPath, branchName, worktreesRoot: realpathSync(tempDirs.make('of-hooks-wt-')), ...extra });

describe('createWorktreeWithHook provides the git hooks directory of the repository', () => {
  it('lets a push from the new worktree run the pre-push hook of the repository', async () => {
    const marker = join(tempDirs.make('of-hooks-marker-'), 'pre-push-ran');
    const repo = aRepoWithHooksPath();
    writeHook(join(repo, HOOKS_PATH), 'pre-push', `touch "${marker}"`);
    const remote = tempDirs.make('of-hooks-remote-');
    git(remote, 'init', '--bare', '-b', 'main');

    const { path } = await createIn(repo, 'task/push');
    git(path, 'push', remote, 'HEAD:refs/heads/pushed');

    expect(existsSync(marker)).toBe(true);
  });

  it('copies every file of the hooks directory with its executable bit', async () => {
    const repo = aRepoWithHooksPath();
    writeHook(join(repo, HOOKS_PATH), 'pre-push', 'exit 0');
    writeFileSync(join(repo, HOOKS_PATH, 'h'), 'shared helper\n');

    const { path } = await createIn(repo, 'task/copy');

    expect(readdirSync(join(path, HOOKS_PATH)).sort()).toEqual(['h', 'pre-push']);
    expect(readFileSync(join(path, HOOKS_PATH, 'h'), 'utf8')).toBe('shared helper\n');
    expect(statSync(join(path, HOOKS_PATH, 'pre-push')).mode & 0o111).not.toBe(0);
  });

  it('answers a hooks_path_missing warning, and still creates the worktree, when the repository has no hooks directory', async () => {
    const repo = aRepoWithHooksPath();

    const created = await createIn(repo, 'task/missing');

    expect(created.warnings).toEqual([{ type: 'hooks_path_missing', hooksPath: HOOKS_PATH }]);
    expect(existsSync(join(created.path, '.git'))).toBe(true);
  });

  it('answers path and branch alone, and creates no hooks directory, when the repository configures no hooks path', async () => {
    const repo = aRepo();

    const created = await createIn(repo, 'task/plain');

    expect(created).toEqual({ path: expect.any(String), branch: 'task/plain' });
    expect(existsSync(join(created.path, '.husky'))).toBe(false);
  });

  it('copies the hooks directory again for a branch that already exists', async () => {
    const repo = aRepoWithHooksPath();
    writeHook(join(repo, HOOKS_PATH), 'pre-push', 'exit 0');
    git(repo, 'branch', 'task/existing');

    const created = await createIn(repo, 'task/existing');

    expect(created.warnings).toBeUndefined();
    expect(existsSync(join(created.path, HOOKS_PATH, 'pre-push'))).toBe(true);
  });

  it('runs the post-create hook after the hooks directory is in place', async () => {
    const marker = join(tempDirs.make('of-hooks-order-'), 'seen');
    const repo = aRepoWithHooksPath();
    writeHook(join(repo, HOOKS_PATH), 'pre-push', 'exit 0');
    const script = join(tempDirs.make('of-hooks-script-'), 'hook.sh');
    writeFileSync(script, `#!/bin/sh\ntest -f "${HOOKS_PATH}/pre-push" && touch "${marker}"\n`);
    chmodSync(script, 0o700);

    await createIn(repo, 'task/order', { hook: { script, timeoutSeconds: 10, projectId: 'project-1' } });

    expect(existsSync(marker)).toBe(true);
  });

  it('reports the hooks warning next to a post-create hook failure', async () => {
    const repo = aRepoWithHooksPath();
    const script = join(tempDirs.make('of-hooks-script-'), 'hook.sh');
    writeFileSync(script, '#!/bin/sh\nexit 3\n');
    chmodSync(script, 0o700);

    const created = await createIn(repo, 'task/both', { hook: { script, timeoutSeconds: 10, projectId: 'project-1' } });

    expect(created.warnings).toMatchObject([{ type: 'hooks_path_missing' }, { type: 'post_create_hook_failed', reason: 'exit_nonzero' }]);
  });

  describe('leaves the worktree untouched when the hooks path is not a plain directory of the repository', () => {
    it('ignores an absolute hooks path', async () => {
      const outside = tempDirs.make('of-hooks-outside-');
      writeHook(outside, 'pre-push', 'exit 0');
      const repo = aRepoWithHooksPath(outside);

      const created = await createIn(repo, 'task/absolute');

      expect(created.warnings).toBeUndefined();
      expect(readdirSync(created.path).filter((entry) => entry !== '.git')).toEqual([]);
    });

    it('ignores a hooks path that climbs out with ..', async () => {
      const repo = aRepoWithHooksPath('../of-hooks-sibling/_');
      writeHook(join(repo, '..', 'of-hooks-sibling', '_'), 'pre-push', 'exit 0');
      repos.push(join(repo, '..', 'of-hooks-sibling'));

      const created = await createIn(repo, 'task/climbing');

      expect(created.warnings).toBeUndefined();
      expect(existsSync(join(created.path, '..', 'of-hooks-sibling'))).toBe(false);
    });

    it('ignores a hooks directory that is itself a symbolic link', async () => {
      const outside = tempDirs.make('of-hooks-outside-');
      writeHook(outside, 'pre-push', 'exit 0');
      const repo = aRepoWithHooksPath();
      mkdirSync(join(repo, '.husky'));
      symlinkSync(outside, join(repo, HOOKS_PATH));

      const created = await createIn(repo, 'task/linked');

      expect(created.warnings).toBeUndefined();
      expect(existsSync(join(created.path, HOOKS_PATH))).toBe(false);
    });

    it('ignores a hooks directory reached through a symbolic link that leaves the repository', async () => {
      const outside = tempDirs.make('of-hooks-outside-');
      writeHook(join(outside, '_'), 'pre-push', 'exit 0');
      const repo = aRepoWithHooksPath();
      symlinkSync(outside, join(repo, '.husky'));

      const created = await createIn(repo, 'task/ancestor');

      expect(created.warnings).toBeUndefined();
      expect(existsSync(join(created.path, HOOKS_PATH))).toBe(false);
    });

    it('does not write through a symbolic link that the checked out branch tracks in place of the hooks parent directory', async () => {
      const outside = tempDirs.make('of-hooks-outside-');
      const repo = aRepoWithHooksPath('hooks/_');
      git(repo, 'checkout', '--orphan', 'task/tracked-link');
      symlinkSync(outside, join(repo, 'hooks'));
      git(repo, 'add', 'hooks');
      git(repo, 'commit', '-m', 'track a link where the hooks parent directory is');
      git(repo, 'checkout', '-f', 'main');
      writeHook(join(repo, 'hooks', '_'), 'pre-push', 'exit 0');

      const created = await createIn(repo, 'task/tracked-link');

      expect(readdirSync(outside)).toEqual([]);
      expect(created.warnings).toBeUndefined();
    });

    it('skips a symbolic link inside the hooks directory and copies the plain files', async () => {
      const secret = join(tempDirs.make('of-hooks-secret-'), 'secret');
      writeFileSync(secret, 'secret');
      const repo = aRepoWithHooksPath();
      writeHook(join(repo, HOOKS_PATH), 'pre-push', 'exit 0');
      symlinkSync(secret, join(repo, HOOKS_PATH, 'leak'));

      const created = await createIn(repo, 'task/leak');

      expect(readdirSync(join(created.path, HOOKS_PATH))).toEqual(['pre-push']);
    });
  });

  it('copies the hooks of the repository whatever git configuration the caller environment injects', async () => {
    const attackerHooks = tempDirs.make('of-hooks-attacker-');
    writeHook(attackerHooks, 'pre-push', 'echo attacker');
    const repo = aRepoWithHooksPath();
    writeHook(join(repo, HOOKS_PATH), 'pre-push', 'echo repository');
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: attackerHooks };

    const created = await createIn(repo, 'task/injected', { env });

    expect(readFileSync(join(created.path, HOOKS_PATH, 'pre-push'), 'utf8')).toContain('echo repository');
  });
});
