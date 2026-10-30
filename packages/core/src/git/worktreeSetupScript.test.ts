import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { runWorktreeSetupScript, SETUP_SCRIPT_RELATIVE_PATH } from './worktreeSetupScript.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const aDirectory = (prefix: string) => realpathSync(tempDirs.make(prefix));

function aRepoWithSetupScript(body: string, mode = 0o755): string {
  const repoPath = aDirectory('of-setup-repo-');
  const script = join(repoPath, SETUP_SCRIPT_RELATIVE_PATH);
  mkdirSync(join(repoPath, 'scripts'));
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, mode);
  return repoPath;
}

const setupInput = (repoPath: string, worktreePath = aDirectory('of-setup-wt-')) => ({ repoPath, worktreePath, branch: 'task/CCM-1', timeoutMs: 5_000 });

describe('runWorktreeSetupScript', () => {
  it('runs the script of the repository in the worktree and answers no warning when it exits 0', async () => {
    const worktreePath = aDirectory('of-setup-wt-');
    const witness = join(aDirectory('of-setup-out-'), 'cwd.txt');
    const repoPath = aRepoWithSetupScript(`pwd -P > "${witness}"`);

    const warning = await runWorktreeSetupScript(setupInput(repoPath, worktreePath));

    expect(warning).toBeUndefined();
    expect(readFileSync(witness, 'utf8').trim()).toBe(worktreePath);
  });

  it('answers no warning and runs nothing when the repository has no setup script', async () => {
    const repoPath = aDirectory('of-setup-repo-');

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning).toBeUndefined();
  });

  it('answers worktree_setup_failed with the exit code and the output when the script fails', async () => {
    const repoPath = aRepoWithSetupScript('echo "lockfile out of date" >&2\nexit 4');

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning).toMatchObject({ type: 'worktree_setup_failed', reason: 'exit_nonzero', exitCode: 4 });
    expect(warning?.outputTail).toContain('lockfile out of date');
  });

  it('answers timeout and kills the script with the background processes it started', async () => {
    const witness = join(aDirectory('of-setup-out-'), 'survivor.txt');
    const repoPath = aRepoWithSetupScript(`(sleep 3; echo alive > "${witness}") &\nwait`);

    const warning = await runWorktreeSetupScript({ ...setupInput(repoPath), timeoutMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    expect(warning).toMatchObject({ type: 'worktree_setup_failed', reason: 'timeout' });
    expect(existsSync(witness)).toBe(false);
  });

  it('refuses a setup script that is a symbolic link leaving the repository, and does not run it', async () => {
    const witness = join(aDirectory('of-setup-out-'), 'ran.txt');
    const outsideScript = join(aDirectory('of-setup-outside-'), 'evil.sh');
    writeFileSync(outsideScript, `#!/bin/sh\ntouch "${witness}"\n`);
    chmodSync(outsideScript, 0o755);
    const repoPath = aDirectory('of-setup-repo-');
    mkdirSync(join(repoPath, 'scripts'));
    symlinkSync(outsideScript, join(repoPath, SETUP_SCRIPT_RELATIVE_PATH));

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning).toMatchObject({ type: 'worktree_setup_failed', reason: 'outside_repository' });
    expect(existsSync(witness)).toBe(false);
  });

  it('refuses a scripts directory that is a symbolic link leaving the repository', async () => {
    const witness = join(aDirectory('of-setup-out-'), 'ran.txt');
    const outsideDirectory = aDirectory('of-setup-outside-');
    writeFileSync(join(outsideDirectory, 'worktree-setup.sh'), `#!/bin/sh\ntouch "${witness}"\n`);
    chmodSync(join(outsideDirectory, 'worktree-setup.sh'), 0o755);
    const repoPath = aDirectory('of-setup-repo-');
    symlinkSync(outsideDirectory, join(repoPath, 'scripts'));

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning).toMatchObject({ reason: 'outside_repository' });
    expect(existsSync(witness)).toBe(false);
  });

  it('runs a setup script that is a symbolic link staying inside the repository', async () => {
    const witness = join(aDirectory('of-setup-out-'), 'ran.txt');
    const repoPath = aDirectory('of-setup-repo-');
    mkdirSync(join(repoPath, 'scripts'));
    const target = join(repoPath, 'scripts', 'real-setup.sh');
    writeFileSync(target, `#!/bin/sh\ntouch "${witness}"\n`);
    chmodSync(target, 0o755);
    symlinkSync('real-setup.sh', join(repoPath, SETUP_SCRIPT_RELATIVE_PATH));

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning).toBeUndefined();
    expect(existsSync(witness)).toBe(true);
  });

  it('keeps only the last 16 KiB of a very long output, with credentials masked', async () => {
    const repoPath = aRepoWithSetupScript('echo "password: hunter2-secret-value" >&2\ni=0\nwhile [ $i -lt 5000 ]; do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done\nexit 1');

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning?.reason).toBe('exit_nonzero');
    expect(warning?.outputTail?.length).toBeLessThanOrEqual(16 * 1024);
    expect(warning?.outputTail?.length).toBeGreaterThan(8 * 1024);
    expect(warning?.outputTail).toContain('line-4999-');
    expect(warning?.outputTail).not.toContain('line-0-');
  });

  it('masks credentials in the output', async () => {
    const repoPath = aRepoWithSetupScript('echo "password: hunter2-secret-value" >&2\nexit 1');

    const warning = await runWorktreeSetupScript(setupInput(repoPath));

    expect(warning?.outputTail).toContain('password: ***');
    expect(warning?.outputTail).not.toContain('hunter2-secret-value');
  });

  it('hands the script the worktree context and nothing from the daemon secrets', async () => {
    const witness = join(aDirectory('of-setup-out-'), 'env.txt');
    const repoPath = aRepoWithSetupScript(`env > "${witness}"`);

    await runWorktreeSetupScript({ ...setupInput(repoPath, '/tmp'), env: { PATH: '/usr/bin:/bin', HOME: '/home/u', OPENFLEET_ADMIN_TOKEN: 'daemon-admin-secret', GITHUB_TOKEN: 'ghp_secret' } });

    const scriptEnv = readFileSync(witness, 'utf8');
    expect(scriptEnv).toContain('OPENFLEET_WORKTREE_PATH=/tmp\n');
    expect(scriptEnv).toContain('OPENFLEET_BRANCH=task/CCM-1\n');
    expect(scriptEnv).toContain(`OPENFLEET_REPO_PATH=${repoPath}\n`);
    expect(scriptEnv).toContain('PATH=/usr/bin:/bin\n');
    expect(scriptEnv).not.toContain('daemon-admin-secret');
    expect(scriptEnv).not.toContain('ghp_secret');
  });

  it('answers not_executable for a script without the execute bit, and unsafe_permissions for one writable by others', async () => {
    expect(await runWorktreeSetupScript(setupInput(aRepoWithSetupScript('exit 0', 0o644)))).toMatchObject({ reason: 'not_executable' });
    expect(await runWorktreeSetupScript(setupInput(aRepoWithSetupScript('exit 0', 0o777)))).toMatchObject({ reason: 'unsafe_permissions' });
  });

  it('answers not_found when the setup script path is a directory', async () => {
    const repoPath = aDirectory('of-setup-repo-');
    mkdirSync(join(repoPath, SETUP_SCRIPT_RELATIVE_PATH), { recursive: true });

    expect(await runWorktreeSetupScript(setupInput(repoPath))).toMatchObject({ reason: 'not_found' });
  });
});
