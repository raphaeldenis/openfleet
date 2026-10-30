import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const setupScript = new URL('./worktree-setup.sh', import.meta.url).pathname;
const SYSTEM_PATH_WITHOUT_PNPM = '/usr/bin:/bin';
let sandbox: string;
let fakeBin: string;
let worktree: string;
let callLog: string;

const PNPM_DOUBLE = [
  '#!/bin/sh',
  'echo "$*" >> "$CALL_LOG"',
  'case "$*" in',
  '  "install --frozen-lockfile") exit "${INSTALL_EXIT:-0}" ;;',
  '  "exec husky") if [ -z "${SKIP_HUSKY_FILES:-}" ]; then mkdir -p .husky/_ && : > .husky/_/pre-push; fi ;;',
  'esac',
  '',
].join('\n');

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'of-setup-script-')));
  fakeBin = join(sandbox, 'bin');
  worktree = join(sandbox, 'worktree');
  callLog = join(sandbox, 'calls.log');
  mkdirSync(fakeBin);
  mkdirSync(worktree);
  writeFileSync(join(fakeBin, 'pnpm'), PNPM_DOUBLE);
  chmodSync(join(fakeBin, 'pnpm'), 0o755);
});
afterEach(() => renameSync(sandbox, `${sandbox}-done`));

const runSetup = (extraEnv: Record<string, string> = {}, path = `${fakeBin}:${SYSTEM_PATH_WITHOUT_PNPM}`) =>
  spawnSync('sh', [setupScript], { cwd: worktree, env: { PATH: path, CALL_LOG: callLog, ...extraEnv }, encoding: 'utf8' });
const callsMade = () => readFileSync(callLog, 'utf8').trim().split('\n');

describe('scripts/worktree-setup.sh', () => {
  it('installs with the frozen lockfile, then runs husky, and leaves .husky/_/pre-push in the worktree', () => {
    const result = runSetup();

    expect(result.status).toBe(0);
    expect(callsMade()).toEqual(['install --frozen-lockfile', 'exec husky']);
    expect(existsSync(join(worktree, '.husky', '_', 'pre-push'))).toBe(true);
  });

  it('is idempotent: a second run succeeds and runs the same two commands', () => {
    runSetup();

    const second = runSetup();

    expect(second.status).toBe(0);
    expect(callsMade()).toEqual(['install --frozen-lockfile', 'exec husky', 'install --frozen-lockfile', 'exec husky']);
  });

  it('stops with the install exit code and does not run husky when the install fails', () => {
    const result = runSetup({ INSTALL_EXIT: '9' });

    expect(result.status).toBe(9);
    expect(callsMade()).toEqual(['install --frozen-lockfile']);
  });

  it('fails when husky leaves no pre-push hook behind', () => {
    const result = runSetup({ SKIP_HUSKY_FILES: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.husky/_/pre-push is missing');
  });

  it('answers 127 with a message when pnpm is not on PATH', () => {
    const result = runSetup({}, SYSTEM_PATH_WITHOUT_PNPM);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain('pnpm is not on PATH');
  });

  it('is POSIX sh: a strict POSIX shell parses it without running it', () => {
    const result = spawnSync('sh', ['-n', setupScript], { encoding: 'utf8' });

    expect(result.status).toBe(0);
  });
});
