import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { runPostCreateHook } from './postCreateHook.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const aWorktreeDirectory = () => realpathSync(tempDirs.make('of-hook-wt-'));

function aScript(body: string, mode = 0o700): string {
  const path = join(tempDirs.make('of-hook-script-'), 'hook.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

const hookInput = (script: string, worktreePath = aWorktreeDirectory()) => ({
  script, worktreePath, branch: 'task/CCM-1', repoPath: '/repos/fleet', projectId: 'project-1', timeoutMs: 5_000,
});

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(condition: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe('runPostCreateHook', () => {
  it('answers no warning when the script exits 0, and runs it with the worktree as its working directory', async () => {
    const worktreePath = aWorktreeDirectory();
    const marker = join(tempDirs.make('of-hook-out-'), 'cwd.txt');
    const script = aScript(`pwd -P > "${marker}"`);

    const warning = await runPostCreateHook(hookInput(script, worktreePath));

    expect(warning).toBeUndefined();
    expect(readFileSync(marker, 'utf8').trim()).toBe(worktreePath);
  });

  it('hands the script the worktree context in OPENFLEET_* variables and nothing from the daemon secrets or session markers', async () => {
    const marker = join(tempDirs.make('of-hook-out-'), 'env.txt');
    const script = aScript(`env > "${marker}"`);
    process.env.SCAPE_EDIT_CAP = 'leaked-cap-token';
    process.env.CLAUDECODE = '1';
    process.env.OPENFLEET_ADMIN_TOKEN = 'daemon-admin-secret';
    try {
      await runPostCreateHook(hookInput(script, '/tmp'));
    } finally {
      delete process.env.SCAPE_EDIT_CAP;
      delete process.env.CLAUDECODE;
      delete process.env.OPENFLEET_ADMIN_TOKEN;
    }

    const scriptEnv = readFileSync(marker, 'utf8');
    expect(scriptEnv).toContain('OPENFLEET_WORKTREE_PATH=/tmp\n');
    expect(scriptEnv).toContain('OPENFLEET_BRANCH=task/CCM-1\n');
    expect(scriptEnv).toContain('OPENFLEET_REPO_PATH=/repos/fleet\n');
    expect(scriptEnv).toContain('OPENFLEET_PROJECT_ID=project-1\n');
    expect(scriptEnv).toContain('PATH=');
    expect(scriptEnv).not.toContain('SCAPE_EDIT_CAP');
    expect(scriptEnv).not.toContain('CLAUDECODE');
    expect(scriptEnv).not.toContain('daemon-admin-secret');
  });

  it('passes no argument to the script and never interprets the branch or the path through a shell', async () => {
    const marker = join(tempDirs.make('of-hook-out-'), 'args.txt');
    const script = aScript(`echo "$#" > "${marker}"`);
    const hostileDirectory = join(tempDirs.make('of-hook-wt-'), 'a b;touch pwned');
    mkdirSync(hostileDirectory);

    const warning = await runPostCreateHook(hookInput(script, hostileDirectory));

    expect(warning).toBeUndefined();
    expect(readFileSync(marker, 'utf8').trim()).toBe('0');
    expect(existsSync(join(hostileDirectory, 'pwned'))).toBe(false);
  });

  it('answers exit_nonzero with the exit code and the tail of the output when the script fails', async () => {
    const script = aScript('echo "installing deps" >&2\nexit 3');

    const warning = await runPostCreateHook(hookInput(script));

    expect(warning).toMatchObject({ type: 'post_create_hook_failed', reason: 'exit_nonzero', exitCode: 3 });
    expect(warning?.outputTail).toContain('installing deps');
  });

  it('answers timeout and kills the script together with the background processes it started', async () => {
    const pidFile = join(tempDirs.make('of-hook-out-'), 'child.pid');
    const script = aScript(`sleep 30 &\necho $! > "${pidFile}"\nwait`);

    const warning = await runPostCreateHook({ ...hookInput(script), timeoutMs: 300 });

    expect(warning).toMatchObject({ type: 'post_create_hook_failed', reason: 'timeout' });
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntil(() => !isProcessAlive(childPid), 3_000)).toBe(true);
  });

  it('answers not_executable for a script without the execute bit', async () => {
    const script = aScript('exit 0', 0o600);

    const warning = await runPostCreateHook(hookInput(script));

    expect(warning).toMatchObject({ type: 'post_create_hook_failed', reason: 'not_executable' });
  });

  it('answers not_found for a script that does not exist and for a relative path', async () => {
    const missing = join(tempDirs.make('of-hook-script-'), 'gone.sh');

    expect(await runPostCreateHook(hookInput(missing))).toMatchObject({ reason: 'not_found' });
    expect(await runPostCreateHook(hookInput('scripts/hook.sh'))).toMatchObject({ reason: 'not_found' });
  });

  it('answers not_found for a directory given as the script', async () => {
    const warning = await runPostCreateHook(hookInput(tempDirs.make('of-hook-dir-')));

    expect(warning).toMatchObject({ reason: 'not_found' });
  });

  it.each([0o770, 0o707, 0o777])('refuses a script writable by group or others (mode %o) without running it', async (mode) => {
    const marker = join(tempDirs.make('of-hook-out-'), 'ran.txt');
    const script = aScript(`touch "${marker}"`, mode);

    const warning = await runPostCreateHook(hookInput(script));

    expect(warning).toMatchObject({ type: 'post_create_hook_failed', reason: 'unsafe_permissions' });
    expect(existsSync(marker)).toBe(false);
  });

  it('masks credentials in the captured output', async () => {
    const script = aScript('echo "password: hunter2-secret-value" >&2\nexit 1');

    const warning = await runPostCreateHook(hookInput(script));

    expect(warning?.outputTail).toContain('password: ***');
    expect(warning?.outputTail).not.toContain('hunter2-secret-value');
  });

  it('keeps only a capped tail of a very large output', async () => {
    const script = aScript('i=0\nwhile [ $i -lt 20000 ]; do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done\nexit 1');

    const warning = await runPostCreateHook(hookInput(script));

    expect(warning?.reason).toBe('exit_nonzero');
    expect(warning?.outputTail?.length).toBeLessThanOrEqual(8192);
    expect(warning?.outputTail).toContain('line-19999-');
    expect(warning?.outputTail).not.toContain('line-0-');
  });

  it('never throws, whatever the script does', async () => {
    const script = aScript('kill -9 $$');

    const warning = await runPostCreateHook(hookInput(script));

    expect(warning).toMatchObject({ type: 'post_create_hook_failed' });
  });

  it('keeps the script path out of the warning', async () => {
    const script = aScript('exit 2');

    const warning = await runPostCreateHook(hookInput(script));

    expect(JSON.stringify(warning)).not.toContain(script);
  });
});
