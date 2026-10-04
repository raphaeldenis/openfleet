import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repository = new URL('../', import.meta.url).pathname;
const worktree = repository.replace(/\/$/, '');
let workDir: string;
let fakeBin: string;

const GH_AND_PNPM_DOUBLE = '#!/bin/sh\nprintf "%s\\0" "$#" "$@" >> "$CALL_LOG"\nexit "${TOOL_EXIT:-0}"\n';
const GIT_DOUBLE = [
  '#!/bin/sh',
  'echo "$*" >> "$GIT_LOG"',
  'case "$*" in',
  '  *--is-inside-work-tree*) echo "${GIT_INSIDE:-true}"; exit "${GIT_INSIDE_EXIT:-0}" ;;',
  '  *refs/heads/*) sha="${GIT_LOCAL_SHA-aaa}" ;;',
  '  *refs/remotes/origin/*) sha="${GIT_REMOTE_SHA-aaa}" ;;',
  '  *) exit 99 ;;',
  'esac',
  '[ -n "$sha" ] || exit 1',
  'echo "$sha"',
  '',
].join('\n');

function installDouble(name: string, script: string) {
  const path = join(fakeBin, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  mkdirSync(join(repository, '.scratch'), { recursive: true });
  workDir = mkdtempSync(join(repository, '.scratch/shims-'));
  fakeBin = join(workDir, 'bin');
  mkdirSync(fakeBin);
  installDouble('pnpm', GH_AND_PNPM_DOUBLE);
  installDouble('gh', GH_AND_PNPM_DOUBLE);
  installDouble('git', GIT_DOUBLE);
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function readLog(path: string, separator: string): string[] {
  try { return readFileSync(path, 'utf8').split(separator).slice(0, -1); } catch { return []; }
}

function runShim(input: { name: string; args?: string[]; toolExit?: string; gitEnv?: Record<string, string> }) {
  const callLog = join(workDir, 'calls');
  const gitLog = join(workDir, 'git-calls');
  const result = spawnSync('/bin/bash', [join(repository, 'scripts', input.name), ...(input.args ?? [])], {
    cwd: workDir, encoding: 'utf8',
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, CALL_LOG: callLog, GIT_LOG: gitLog, TOOL_EXIT: input.toolExit ?? '0', ...input.gitEnv },
  });
  return { ...result, calls: readLog(callLog, '\0'), gitCalls: readLog(gitLog, '\n') };
}

function openPrArgs(overrides: { head?: string | null; bodyFile: string }): string[] {
  const head = overrides.head === null ? [] : ['--head', overrides.head ?? 'feature-x'];
  return ['--repo', 'owner/project', '--title', 'feat: literal $(touch bad)', '--body-file', overrides.bodyFile, '--base', 'main', ...head];
}

function writeBodyFile(): string {
  const bodyFile = join(workDir, 'body with spaces.md');
  writeFileSync(bodyFile, 'PR description');
  return bodyFile;
}

const NOT_A_WORKTREE_CASES: { case: string; gitEnv: Record<string, string> }[] = [
  { case: 'a bare repository', gitEnv: { GIT_INSIDE: 'false' } },
  { case: 'a path outside any repository', gitEnv: { GIT_INSIDE_EXIT: '128' } },
];

describe('verify.sh', () => {
  it('runs architecture, typecheck and core tests against the selected worktree', () => {
    const result = runShim({ name: 'verify.sh', args: [repository] });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['3', '--dir', worktree, 'arch', '3', '--dir', worktree, 'typecheck', '5', '--dir', worktree, '--filter', '@openfleet/core', 'test']);
  });

  it('stops verification on the first failed check', () => {
    const result = runShim({ name: 'verify.sh', args: [repository], toolExit: '7' });
    expect(result.status).toBe(7);
    expect(result.calls).toEqual(['3', '--dir', worktree, 'arch']);
  });

  it('asks git whether the selected directory is a worktree', () => {
    const result = runShim({ name: 'verify.sh', args: [repository] });
    expect(result.gitCalls).toContain(`-C ${worktree} rev-parse --is-inside-work-tree`);
  });

  it.each(NOT_A_WORKTREE_CASES)('refuses $case before running pnpm', ({ gitEnv }) => {
    const result = runShim({ name: 'verify.sh', args: [repository], gitEnv });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a git worktree');
    expect(result.calls).toEqual([]);
  });
});

describe('open-pr.sh', () => {
  it('passes the title, body file and published head to gh without interpreting them', () => {
    const bodyFile = writeBodyFile();
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile }) });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['12', 'pr', 'create', '--repo', 'owner/project', '--title', 'feat: literal $(touch bad)', '--body-file', bodyFile, '--base', 'main', '--head', 'feature-x']);
  });

  it('refuses a missing body file before contacting GitHub', () => {
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile: join(workDir, 'absent') }) });
    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });

  it('refuses a call without an explicit head so gh never offers to push', () => {
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile: writeBodyFile(), head: null }) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--head');
    expect(result.calls).toEqual([]);
  });

  it('refuses a head that is not published on origin', () => {
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile: writeBodyFile() }), gitEnv: { GIT_REMOTE_SHA: '' } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not published');
    expect(result.calls).toEqual([]);
  });

  it('refuses a head whose local commits are not all published', () => {
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile: writeBodyFile() }), gitEnv: { GIT_LOCAL_SHA: 'bbb', GIT_REMOTE_SHA: 'aaa' } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not published');
    expect(result.calls).toEqual([]);
  });

  it('refuses a head that does not exist locally', () => {
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile: writeBodyFile() }), gitEnv: { GIT_LOCAL_SHA: '' } });
    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });

  it.each(NOT_A_WORKTREE_CASES)('refuses $case before contacting GitHub', ({ gitEnv }) => {
    const result = runShim({ name: 'open-pr.sh', args: openPrArgs({ bodyFile: writeBodyFile() }), gitEnv });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a git worktree');
    expect(result.calls).toEqual([]);
  });

  it('checks the selected worktree and never pushes', () => {
    const result = runShim({ name: 'open-pr.sh', args: [...openPrArgs({ bodyFile: writeBodyFile() }), '--worktree', worktree] });
    expect(result.status).toBe(0);
    expect(result.gitCalls).toContain(`-C ${worktree} rev-parse --is-inside-work-tree`);
    expect(result.gitCalls.filter((call) => call.includes('push'))).toEqual([]);
  });
});
