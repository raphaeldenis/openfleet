import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'prepare.mjs');

const TAURI_CONF = '{\n  "productName": "OpenFleet",\n  "version": "0.1.0",\n  "identifier": "dev.openfleet.desktop"\n}\n';
const CARGO_TOML = '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n';
const CARGO_LOCK = '# lock\nversion = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n';
const packageJson = (name: string) => `{\n  "name": "${name}",\n  "version": "0.1.0"\n}\n`;
const VERSION_FILES = {
  'apps/desktop/src-tauri/tauri.conf.json': TAURI_CONF,
  'apps/desktop/src-tauri/Cargo.toml': CARGO_TOML,
  'apps/desktop/src-tauri/Cargo.lock': CARGO_LOCK,
  'packages/core/package.json': packageJson('@openfleet/core'),
  'packages/shared/package.json': packageJson('@openfleet/shared'),
  'apps/desktop/package.json': packageJson('@openfleet/desktop'),
};
const TAURI_CONF_PATH = 'apps/desktop/src-tauri/tauri.conf.json';

let root: string;
let fakeBin: string;

const isolatedEnvironment = (extra: Record<string, string> = {}) => {
  const withoutGitVariables = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...withoutGitVariables, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: `${fakeBin}:${process.env.PATH}`, ...extra } as NodeJS.ProcessEnv;
};
const git = (...args: string[]) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: isolatedEnvironment() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (relativePath: string, content: string) => {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), content);
};
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8');
const commit = (subject: string) => git('commit', '--allow-empty', '-m', subject);
const runPrepare = (args: string[], extraEnvironment: Record<string, string> = {}) =>
  spawnSync('node', [SCRIPT, ...args, '--root', root], { encoding: 'utf8', env: isolatedEnvironment(extraEnvironment) });
const pnpmCalls = () => (existsSync(join(fakeBin, 'pnpm.log')) ? readFileSync(join(fakeBin, 'pnpm.log'), 'utf8').trim().split('\n') : []);

beforeEach(() => {
  const sandbox = mkdtempSync(join(tmpdir(), 'of-prepare-'));
  root = join(sandbox, 'repo');
  fakeBin = join(sandbox, 'bin');
  mkdirSync(root);
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'pnpm'), '#!/bin/sh\necho "$@" >> "$(dirname "$0")/pnpm.log"\nexit "${FAKE_PNPM_STATUS:-0}"\n');
  chmodSync(join(fakeBin, 'pnpm'), 0o755);

  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  for (const [path, content] of Object.entries(VERSION_FILES)) write(path, content);
  write('.gitignore', 'release-notes-v*.md\n');
  git('add', '-A');
  commit('chore: initial commit');
  git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  commit('feat(core): add the fleet view');
  commit('fix(desktop): keep the window open');
});
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }));

describe('prepare: refusals leave the repository untouched', () => {
  it('refuses a modified tracked file', () => {
    write('packages/core/package.json', `${packageJson('@openfleet/core')}\n`);

    const result = runPrepare(['0.2.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('uncommitted or untracked files');
    expect(read(TAURI_CONF_PATH)).toBe(TAURI_CONF);
  });

  it('refuses an untracked file', () => {
    write('scripts/stray.txt', 'left over');

    const result = runPrepare(['0.2.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scripts/stray.txt');
  });

  it('refuses a branch other than main and names the fix', () => {
    git('switch', '-c', 'feature/x');

    const result = runPrepare(['0.2.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('git switch main');
    expect(read(TAURI_CONF_PATH)).toBe(TAURI_CONF);
  });

  it('refuses a detached HEAD', () => {
    git('checkout', '--detach');

    const result = runPrepare(['0.2.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"HEAD"');
  });

  it.each(['0.1.0', '0.0.9', '0.1.0-beta.1'])('refuses %s, not greater than the current 0.1.0', (version) => {
    const result = runPrepare([version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not greater than the current version 0.1.0');
    expect(read(TAURI_CONF_PATH)).toBe(TAURI_CONF);
  });

  it.each(['', 'v0.2.0', '0.2', 'garbage'])('refuses the invalid version "%s"', (version) => {
    const result = runPrepare(version ? [version] : []);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SemVer|version is required/);
  });

  it('refuses a tag that already exists and names the fix', () => {
    git('tag', 'v0.2.0');

    const result = runPrepare(['0.2.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('git tag -d v0.2.0');
  });

  it('refuses an unknown flag', () => {
    const result = runPrepare(['0.2.0', '--force']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown flag --force');
  });
});

describe('prepare: dry run', () => {
  it('prints every step and the next commands but changes nothing and runs no check', () => {
    const headBefore = git('rev-parse', 'HEAD');

    const result = runPrepare(['0.2.0', '--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('step 1/3');
    expect(result.stdout).toContain('step 2/3');
    expect(result.stdout).toContain('step 3/3');
    expect(result.stdout).toContain('git commit -m "chore(release): v0.2.0"');
    expect(git('status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(pnpmCalls()).toEqual([]);
  });
});

describe('prepare: happy path', () => {
  it('bumps every version file, runs the checks and writes the notes grouped since the last tag', () => {
    const result = runPrepare(['0.2.0']);

    expect(result.status).toBe(0);
    expect(read(TAURI_CONF_PATH)).toBe(TAURI_CONF.replace('0.1.0', '0.2.0'));
    expect(read('apps/desktop/src-tauri/Cargo.toml')).toContain('version = "0.2.0"');
    expect(pnpmCalls()).toEqual(['arch', 'typecheck', 'test', '--filter @openfleet/desktop test']);
    const notes = read('release-notes-v0.2.0.md');
    expect(notes).toContain('# OpenFleet v0.2.0');
    expect(notes).toContain('## Features\n- **core:** add the fleet view');
    expect(notes).toContain('## Fixes\n- **desktop:** keep the window open');
    expect(notes).not.toContain('initial commit');
  });

  it('prints the exact commit, tag and push commands for the files it changed', () => {
    const result = runPrepare(['0.2.0']);

    expect(result.stdout).toContain(`git add ${Object.keys(VERSION_FILES).sort().join(' ')}`);
    expect(result.stdout).toContain('git commit -m "chore(release): v0.2.0"');
    expect(result.stdout).toContain('git tag -a v0.2.0 -m "OpenFleet v0.2.0"');
    expect(result.stdout).toContain('git push origin main v0.2.0');
  });

  it('creates no commit and no tag, and stages nothing', () => {
    const headBefore = git('rev-parse', 'HEAD');

    runPrepare(['0.2.0']);

    expect(git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(git('tag', '--list')).toBe('v0.1.0');
    expect(git('diff', '--cached', '--name-only')).toBe('');
  });

  it('accepts a pre-release version greater than the current one', () => {
    const result = runPrepare(['0.2.0-beta.1']);

    expect(result.status).toBe(0);
    expect(read(TAURI_CONF_PATH)).toContain('"version": "0.2.0-beta.1"');
  });

  it('ignores the GIT_DIR a hook would export', () => {
    const result = runPrepare(['0.2.0', '--skip-checks'], { GIT_DIR: join(dirname(root), 'elsewhere') });

    expect(result.status).toBe(0);
  });
});

describe('prepare: flags', () => {
  it('warns loudly and still prepares on another branch with --allow-non-main', () => {
    git('switch', '-c', 'release/x');

    const result = runPrepare(['0.2.0', '--allow-non-main', '--skip-checks']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARNING');
    expect(result.stderr).toContain('"release/x"');
    expect(result.stdout).toContain('git push origin release/x v0.2.0');
  });

  it('warns that the checks did not run and runs none with --skip-checks', () => {
    const result = runPrepare(['0.2.0', '--skip-checks']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--skip-checks');
    expect(pnpmCalls()).toEqual([]);
  });
});

describe('prepare: a failing check', () => {
  it('exits 2, names the check and explains how to undo the bump', () => {
    const result = runPrepare(['0.2.0'], { FAKE_PNPM_STATUS: '1' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"architecture" check failed');
    expect(result.stderr).toContain('git restore');
    expect(existsSync(join(root, 'release-notes-v0.2.0.md'))).toBe(false);
  });
});
