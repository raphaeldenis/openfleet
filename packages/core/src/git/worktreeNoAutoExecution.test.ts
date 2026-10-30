import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { makeRepo } from './testRepo.js';
import { createWorktreeWithHook } from './worktreeCreation.js';

const tempDirs = createTempDirTracker();
const repos: string[] = [];

afterEach(() => {
  tempDirs.removeAll();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const SETUP_SCRIPT = join('scripts', 'worktree-setup.sh');

function plantExecutableSetupScript(directory: string, witness: string): void {
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  const script = join(directory, SETUP_SCRIPT);
  writeFileSync(script, `#!/bin/sh\ntouch "${witness}"\n`);
  chmodSync(script, 0o755);
}

const createIn = (repoPath: string, branchName: string, extra: { hook?: { script: string; timeoutSeconds: number; projectId: string } } = {}) =>
  createWorktreeWithHook({ repoPath, branchName, worktreesRoot: realpathSync(tempDirs.make('of-noauto-wt-')), ...extra });

describe('createWorktreeWithHook never runs a script found in a repository', () => {
  it('runs nothing when the repository holds an executable scripts/worktree-setup.sh and the project configures no post-create hook', async () => {
    const witness = join(tempDirs.make('of-noauto-out-'), 'ran.txt');
    const repo = realpathSync(makeRepo());
    repos.push(repo);
    plantExecutableSetupScript(repo, witness);

    const created = await createIn(repo, 'task/plain');

    expect(existsSync(witness)).toBe(false);
    expect(created).not.toHaveProperty('warnings');
  });

  it('runs the script the project configures and still not the one of the repository', async () => {
    const outputDirectory = tempDirs.make('of-noauto-out-');
    const repositoryWitness = join(outputDirectory, 'repository-script-ran.txt');
    const projectWitness = join(outputDirectory, 'project-hook-ran.txt');
    const projectScript = join(tempDirs.make('of-noauto-hook-'), 'hook.sh');
    writeFileSync(projectScript, `#!/bin/sh\ntouch "${projectWitness}"\n`);
    chmodSync(projectScript, 0o700);
    const repo = realpathSync(makeRepo());
    repos.push(repo);
    plantExecutableSetupScript(repo, repositoryWitness);

    const created = await createIn(repo, 'task/configured', { hook: { script: projectScript, timeoutSeconds: 30, projectId: 'project-1' } });

    expect(existsSync(projectWitness)).toBe(true);
    expect(existsSync(repositoryWitness)).toBe(false);
    expect(created).not.toHaveProperty('warnings');
  });

  it('runs nothing when the caller names its own linked worktree, holding such a script, as the repository', async () => {
    const witness = join(tempDirs.make('of-noauto-out-'), 'ran.txt');
    const repo = realpathSync(makeRepo());
    repos.push(repo);
    const callersWorktree = (await createIn(repo, 'task/caller')).path;
    plantExecutableSetupScript(callersWorktree, witness);

    const created = await createIn(callersWorktree, 'task/from-worktree');

    expect(existsSync(witness)).toBe(false);
    expect(existsSync(join(created.path, '.git'))).toBe(true);
    expect(created).not.toHaveProperty('warnings');
  });
});
