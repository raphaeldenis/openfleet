import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const runLib = (script: string, { stdin = '', env = {} }: { stdin?: string; env?: Record<string, string> } = {}): string[] => {
  const result = spawnSync('sh', ['-c', `. "${LIB}"; ${script}`], { cwd: repo, input: stdin, encoding: 'utf8', env: cleanEnv(env) });
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

  it('ignores a deleted ref', () => {
    commitFiles('docs/a.md');

    const files = runLib('pushed_files', { stdin: pushLine({ localRef: '(delete)', localSha: ZEROS, remoteSha: 'a'.repeat(40) }) });

    expect(files).toEqual([]);
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

  it('runs e2e only when desktop src is touched', () => {
    const localSha = commitFiles('apps/desktop/src/app/app-root.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['e2e']);
  });

  it('runs e2e when core api is touched', () => {
    const localSha = commitFiles('packages/core/src/api/routes.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['e2e']);
  });

  it('runs e2e when shared src is touched', () => {
    const localSha = commitFiles('packages/shared/src/index.ts');

    expect(stepsForPush(pushLine({ localSha }))).toEqual(['e2e']);
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

    expect(steps).toEqual(['cargo', 'e2e']);
  });

  it('runs nothing for a deleted ref', () => {
    expect(stepsForPush(pushLine({ localRef: '(delete)', localSha: ZEROS, remoteSha: 'a'.repeat(40) }))).toEqual([]);
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
