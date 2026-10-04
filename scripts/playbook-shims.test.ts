import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repository = new URL('../', import.meta.url).pathname;
let workDir: string;
let fakeBin: string;

beforeEach(() => {
  mkdirSync(join(repository, '.scratch'), { recursive: true });
  workDir = mkdtempSync(join(repository, '.scratch/shims-'));
  fakeBin = join(workDir, 'bin');
  mkdirSync(fakeBin);
  for (const tool of ['pnpm', 'gh']) {
    const path = join(fakeBin, tool);
    writeFileSync(path, '#!/bin/sh\nprintf "%s\\0" "$#" "$@" >> "$CALL_LOG"\nexit "${TOOL_EXIT:-0}"\n');
    chmodSync(path, 0o755);
  }
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function runShim(input: { name: string; args?: string[]; toolExit?: string }) {
  const callLog = join(workDir, 'calls');
  const result = spawnSync('/bin/bash', [join(repository, 'scripts', input.name), ...(input.args ?? [])], {
    cwd: workDir, encoding: 'utf8',
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, CALL_LOG: callLog, TOOL_EXIT: input.toolExit ?? '0' },
  });
  const calls = (() => { try { return readFileSync(callLog, 'utf8').split('\0').slice(0, -1); } catch { return []; } })();
  return { ...result, calls };
}

describe('Bash playbook shims', () => {
  it('runs architecture, typecheck and core tests against the selected worktree', () => {
    const result = runShim({ name: 'verify.sh', args: [repository] });
    expect(result.status).toBe(0);
    const worktree = repository.replace(/\/$/, '');
    expect(result.calls).toEqual(['3', '--dir', worktree, 'arch', '3', '--dir', worktree, 'typecheck', '5', '--dir', worktree, '--filter', '@openfleet/core', 'test']);
  });

  it('stops verification on the first failed check', () => {
    const result = runShim({ name: 'verify.sh', args: [repository], toolExit: '7' });
    expect(result.status).toBe(7);
    expect(result.calls).toEqual(['3', '--dir', repository.replace(/\/$/, ''), 'arch']);
  });

  it('passes the title and existing body file to gh without interpreting them', () => {
    const bodyFile = join(workDir, 'body with spaces.md');
    writeFileSync(bodyFile, 'PR description');
    const result = runShim({ name: 'open-pr.sh', args: ['--repo', 'owner/project', '--title', 'feat: literal $(touch bad)', '--body-file', bodyFile, '--base', 'main'] });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['10', 'pr', 'create', '--repo', 'owner/project', '--title', 'feat: literal $(touch bad)', '--body-file', bodyFile, '--base', 'main']);
  });

  it('refuses a missing body file before contacting GitHub', () => {
    const result = runShim({ name: 'open-pr.sh', args: ['--repo', 'owner/project', '--title', 'title', '--body-file', join(workDir, 'absent')] });
    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });
});
