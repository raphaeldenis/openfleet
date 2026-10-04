import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIB = join(dirname(fileURLToPath(import.meta.url)), 'pre-push-lib.sh');
const ZEROS = '0'.repeat(40);

const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_') && !key.startsWith('OPENFLEET_')) env[key] = value;
  }
  return { ...env, ...extra };
};

let repo: string;

const git = (...args: string[]): string => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: cleanEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const commitFiles = (...paths: string[]): string => {
  for (const path of paths) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), `${path} ${Math.random()}\n`);
  }
  git('add', '-A');
  git('commit', '-m', `touch ${paths.join(',')}`);
  return git('rev-parse', 'HEAD');
};

const runLibCapturingAll = (script: string, { stdin = '', env = {} }: { stdin?: string; env?: Record<string, string> } = {}) => {
  const result = spawnSync('sh', ['-c', `. "${LIB}"; ${script}`], { cwd: repo, input: stdin, encoding: 'utf8', env: cleanEnv(env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const runLib = (script: string, { stdin = '', env = {} }: { stdin?: string; env?: Record<string, string> } = {}): string[] => {
  const result = runLibCapturingAll(script, { stdin, env });
  if (result.status !== 0) throw new Error(`sh failed: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
};

const pushLine = ({ localRef = 'refs/heads/feature', localSha, remoteRef = 'refs/heads/feature', remoteSha = ZEROS }: { localRef?: string; localSha: string; remoteRef?: string; remoteSha?: string }) => `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;

const stepsForPush = (stdin: string) => runLib('pushed_files | steps_for_files', { stdin });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pre-push-lib-'));
  git('init', '-q', '-b', 'main');
  const mainSha = commitFiles('README.md');
  git('update-ref', 'refs/remotes/origin/main', mainSha);
  git('checkout', '-q', '-b', 'feature');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pushed_files', () => {
  it('lists the files of a new branch against origin/main', () => {
    const localSha = commitFiles('apps/desktop/src-tauri/src/lib.rs', 'docs/a.md');

    const files = runLib('pushed_files', { stdin: pushLine({ localSha }) });

    expect(files).toEqual(['apps/desktop/src-tauri/src/lib.rs', 'docs/a.md']);
  });

  it('lists only the files since the remote sha for an existing branch', () => {
    const remoteSha = commitFiles('docs/old.md');
    const localSha = commitFiles('packages/shared/src/x.ts');

    const files = runLib('pushed_files', { stdin: pushLine({ localSha, remoteSha }) });

    expect(files).toEqual(['packages/shared/src/x.ts']);
  });

  it('falls back to origin/main when the remote sha is unknown locally', () => {
    const localSha = commitFiles('docs/a.md');

    const files = runLib('pushed_files', { stdin: pushLine({ localSha, remoteSha: 'f'.repeat(40) }) });

    expect(files).toEqual(['docs/a.md']);
  });

  it('ignores a deleted ref without calling git on it', () => {
    commitFiles('docs/a.md');

    const { stdout, stderr } = runLibCapturingAll('pushed_files', { stdin: pushLine({ localRef: '(delete)', localSha: ZEROS, remoteSha: 'a'.repeat(40) }) });

    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('lists the old path of a file renamed out of its folder', () => {
    const remoteSha = commitFiles('apps/desktop/src-tauri/src/lib.rs');
    mkdirSync(join(repo, 'other'));
    git('mv', 'apps/desktop/src-tauri/src/lib.rs', 'other/lib.rs');
    git('commit', '-q', '-m', 'move out');
    const localSha = git('rev-parse', 'HEAD');

    const files = runLib('pushed_files', { stdin: pushLine({ localSha, remoteSha }) });

    expect(files).toEqual(['apps/desktop/src-tauri/src/lib.rs', 'other/lib.rs']);
  });

  it('lists the old path of a file renamed out of its folder on a new branch', () => {
    git('checkout', '-q', 'main');
    commitFiles('apps/desktop/src-tauri/src/lib.rs');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'mover');
    mkdirSync(join(repo, 'other'));
    git('mv', 'apps/desktop/src-tauri/src/lib.rs', 'other/lib.rs');
    git('commit', '-q', '-m', 'move out');
    const localSha = git('rev-parse', 'HEAD');

    const files = runLib('pushed_files', { stdin: pushLine({ localSha }) });

    expect(files).toEqual(['apps/desktop/src-tauri/src/lib.rs', 'other/lib.rs']);
  });

  it.each([
    { label: 'an accent', path: 'apps/desktop/src/café.ts' },
    { label: 'a space', path: 'apps/desktop/src/my file.ts' },
    { label: 'a tab', path: 'apps/desktop/src/tab\there.ts' },
  ])('prints a path with $label unquoted', ({ path }) => {
    const localSha = commitFiles(path);

    const files = runLib('pushed_files', { stdin: pushLine({ localSha }) });

    expect(files).toEqual([path]);
  });

  it('merges several refs without duplicates', () => {
    const firstSha = commitFiles('docs/a.md', 'shared.txt');
    git('checkout', '-q', '-b', 'second', 'origin/main');
    const secondSha = commitFiles('packages/core/src/api/routes.ts', 'shared.txt');

    const files = runLib('pushed_files', { stdin: pushLine({ localSha: firstSha }) + pushLine({ localRef: 'refs/heads/second', remoteRef: 'refs/heads/second', localSha: secondSha }) });

    expect(files).toEqual(['docs/a.md', 'packages/core/src/api/routes.ts', 'shared.txt']);
  });

  it('prints nothing for an empty stdin', () => {
    expect(runLib('pushed_files')).toEqual([]);
  });
});

describe('steps_for_files', () => {
  it('runs cargo only when src-tauri is touched', () => {
    const localSha = commitFiles('apps/desktop/src-tauri/src/lib.rs');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['cargo']);
  });

  it('runs the desktop build and e2e when desktop src is touched', () => {
    const localSha = commitFiles('apps/desktop/src/app/app-root.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['desktop-build', 'e2e']);
  });

  it('runs the desktop build when the desktop package files are touched', () => {
    const localSha = commitFiles('apps/desktop/angular.json');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['desktop-build']);
  });

  it('does not build the desktop for e2e specs only', () => {
    const localSha = commitFiles('apps/desktop/e2e/phase1.spec.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual([]);
  });

  it('runs e2e when core api is touched', () => {
    const localSha = commitFiles('packages/core/src/api/routes.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['e2e']);
  });

  it('runs the desktop build and e2e when shared src is touched', () => {
    const localSha = commitFiles('packages/shared/src/index.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['desktop-build', 'e2e']);
  });

  it('runs nothing extra for docs only', () => {
    const localSha = commitFiles('docs/a.md', 'README.md');

    expect(stepsForPush(pushLine({ localSha }))).toEqual([]);
  });

  it('does not treat core sources outside api as e2e relevant', () => {
    const localSha = commitFiles('packages/core/src/harness/x.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual([]);
  });

  it('runs both steps when several refs touch both areas', () => {
    const firstSha = commitFiles('apps/desktop/src-tauri/src/lib.rs');
    git('checkout', '-q', '-b', 'second', 'origin/main');
    const secondSha = commitFiles('apps/desktop/src/app/app-root.ts');

    const steps = stepsForPush(pushLine({ localSha: firstSha }) + pushLine({ localRef: 'refs/heads/second', remoteRef: 'refs/heads/second', localSha: secondSha }));

    expect(steps).toEqual(['cargo', 'desktop-build', 'e2e']);
  });

  it('runs e2e for an accented file name in desktop src', () => {
    const localSha = commitFiles('apps/desktop/src/café.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['desktop-build', 'e2e']);
  });

  it('runs cargo when a file is moved out of src-tauri', () => {
    const remoteSha = commitFiles('apps/desktop/src-tauri/src/lib.rs');
    mkdirSync(join(repo, 'other'));
    git('mv', 'apps/desktop/src-tauri/src/lib.rs', 'other/lib.rs');
    git('commit', '-q', '-m', 'move out');
    const localSha = git('rev-parse', 'HEAD');

    expect(stepsForPush(pushLine({ localSha, remoteSha }))).toEqual(['cargo']);
  });

  it('runs nothing for a deleted ref', () => {
    expect(stepsForPush(pushLine({ localRef: '(delete)', localSha: ZEROS, remoteSha: 'a'.repeat(40) }))).toEqual([]);
  });
});

describe('untracked_test_inputs', () => {
  it('lists untracked files under packages, apps and scripts', () => {
    mkdirSync(join(repo, 'packages/core/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/core/src/forgotten.ts'), 'x\n');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts/helper.sh'), 'x\n');

    expect(runLib('untracked_test_inputs')).toEqual(['packages/core/src/forgotten.ts', 'scripts/helper.sh']);
  });

  it('ignores gitignored files and untracked files outside the test directories', () => {
    commitFiles('.gitignore');
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    mkdirSync(join(repo, 'apps/desktop/dist'), { recursive: true });
    writeFileSync(join(repo, 'apps/desktop/dist/main.js'), 'x\n');
    writeFileSync(join(repo, 'notes.md'), 'x\n');

    expect(runLib('untracked_test_inputs')).toEqual([]);
  });

  it('prints a path with a space unquoted', () => {
    mkdirSync(join(repo, 'apps'), { recursive: true });
    writeFileSync(join(repo, 'apps/my file.ts'), 'x\n');

    expect(runLib('untracked_test_inputs')).toEqual(['apps/my file.ts']);
  });
});

describe('uncommitted_test_inputs', () => {
  it('lists tracked files modified in the working tree under the test directories', () => {
    commitFiles('packages/core/src/a.ts', 'docs/b.md');
    writeFileSync(join(repo, 'packages/core/src/a.ts'), 'changed\n');
    writeFileSync(join(repo, 'docs/b.md'), 'changed\n');

    expect(runLib('uncommitted_test_inputs')).toEqual(['packages/core/src/a.ts']);
  });

  it('ignores untracked files', () => {
    mkdirSync(join(repo, 'apps'), { recursive: true });
    writeFileSync(join(repo, 'apps/new.ts'), 'x\n');

    expect(runLib('uncommitted_test_inputs')).toEqual([]);
  });
});

describe('claude_free_core_tests', () => {
  let fakeBin: string;

  const installFakeTool = (name: string, body: string) => {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(fakeBin, name), 0o755);
  };

  const installFakePnpm = ({ versionExitCode, suiteExitCode }: { versionExitCode: number; suiteExitCode: number }) => {
    installFakeTool('node', 'exit 0');
    installFakeTool('pnpm', `[ "$1" = "--version" ] && exit ${versionExitCode}\necho "suite args=$* tmpdir=$TMPDIR corepack=$COREPACK_ENABLE_DOWNLOAD_PROMPT claude=$(command -v claude)"\nexit ${suiteExitCode}`);
  };

  const runClaudeFreeCoreTests = (prefix = '') => runLibCapturingAll(`${prefix}claude_free_core_tests`, { env: { PATH: `${fakeBin}:/usr/bin:/bin` } });

  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'pre-push-fakebin-'));
  });

  afterEach(() => {
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it('runs the core suite in a minimal environment without claude and without corepack prompts', () => {
    installFakePnpm({ versionExitCode: 0, suiteExitCode: 0 });

    const { status, stdout } = runClaudeFreeCoreTests();

    expect(status).toBe(0);
    expect(stdout).toContain('suite args=--filter @openfleet/core test');
    expect(stdout).toContain('corepack=0');
    expect(stdout).toContain('claude=\n');
  });

  it('skips with a warning instead of failing when pnpm cannot run in the minimal environment', () => {
    installFakePnpm({ versionExitCode: 1, suiteExitCode: 1 });

    const { status, stdout, stderr } = runClaudeFreeCoreTests();

    expect(status).toBe(0);
    expect(stdout).not.toContain('suite args');
    expect(stderr).toContain('pnpm cannot run in a minimal PATH here: claude-free check skipped');
  });

  it('blames neither claude nor anything specific when the suite fails', () => {
    installFakePnpm({ versionExitCode: 0, suiteExitCode: 1 });

    const { status, stderr } = runClaudeFreeCoreTests();

    expect(status).toBe(1);
    expect(stderr).toContain('the core tests fail without claude on the PATH (a test may depend on claude being installed, or on TMPDIR/HOME): see the output above');
    expect(stderr).not.toContain('depends on claude being installed: CI');
  });

  it('gives the suite an absolute TMPDIR when the caller has none', () => {
    installFakePnpm({ versionExitCode: 0, suiteExitCode: 0 });

    const { stdout } = runClaudeFreeCoreTests('unset TMPDIR; ');

    expect(stdout).toMatch(/tmpdir=\/\S+/);
  });
});

describe('decide_e2e', () => {
  it.each([
    { forced: '1', touched: 'no', expected: 'force' },
    { forced: '1', touched: 'yes', expected: 'force' },
    { forced: '0', touched: 'yes', expected: 'skip' },
    { forced: '', touched: 'yes', expected: 'auto' },
    { forced: '', touched: 'no', expected: 'skip' },
  ])('prints $expected when OPENFLEET_PREPUSH_E2E="$forced" and touched=$touched', ({ forced, touched, expected }) => {
    const decision = runLib(`decide_e2e ${touched}`, { env: { OPENFLEET_PREPUSH_E2E: forced } });

    expect(decision).toEqual([expected]);
  });
});
