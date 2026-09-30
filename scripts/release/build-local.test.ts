import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'build-local.sh');
const ARM64_TARGET = 'aarch64-apple-darwin';
const X64_TARGET = 'x86_64-apple-darwin';
const SYSTEM_PATH = '/usr/bin:/bin';
const USAGE_LINE = 'usage: build-local.sh [--target aarch64-apple-darwin|x86_64-apple-darwin]';

const scratchFolders: string[] = [];
const makeScratchFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'of-build-local-'));
  scratchFolders.push(folder);
  return folder;
};
afterAll(() => {
  for (const folder of scratchFolders) rmSync(folder, { recursive: true, force: true });
});

const writeRustupStub = ({ installedTargets }: { installedTargets: string[] }) => {
  const stubFolder = makeScratchFolder();
  const stub = join(stubFolder, 'rustup');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' ${installedTargets.map((target) => `'${target}'`).join(' ')}\n`);
  chmodSync(stub, 0o755);
  return stubFolder;
};

/** Runs the script hermetically: scratch HOME/RUSTUP_HOME/CARGO_HOME, no extra PATH folders, and a PATH made of the stub folder and the system folders only. */
const runBuildLocal = ({ arguments_, stubFolder }: { arguments_: string[]; stubFolder?: string }) => {
  const scratchHome = makeScratchFolder();
  return spawnSync('/bin/bash', [SCRIPT, ...arguments_], {
    encoding: 'utf8',
    env: {
      HOME: scratchHome,
      RUSTUP_HOME: scratchHome,
      CARGO_HOME: scratchHome,
      OPENFLEET_BUILD_EXTRA_PATH: '',
      PATH: stubFolder === undefined ? SYSTEM_PATH : `${stubFolder}:${SYSTEM_PATH}`,
    },
  });
};

describe('build-local.sh argument parsing', () => {
  it.each([
    { name: 'an unknown flag', arguments_: ['--bogus'] },
    { name: 'the --target=value form', arguments_: [`--target=${X64_TARGET}`] },
    { name: '--target without a value', arguments_: ['--target'] },
    { name: 'two targets', arguments_: ['--target', ARM64_TARGET, '--target', X64_TARGET] },
  ])('prints the usage line and exits 1 for $name', ({ arguments_ }) => {
    const result = runBuildLocal({ arguments_ });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(USAGE_LINE);
  });

  it('refuses an unsupported target naming both supported ones', () => {
    const result = runBuildLocal({ arguments_: ['--target', 'riscv64-unknown-linux-gnu'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unsupported target "riscv64-unknown-linux-gnu".*aarch64-apple-darwin.*x86_64-apple-darwin/);
  });

  it('tolerates a leading -- before --target, as pnpm forwards it', () => {
    const result = runBuildLocal({ arguments_: ['--', '--target', 'riscv64-unknown-linux-gnu'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported target "riscv64-unknown-linux-gnu"');
    expect(result.stderr).not.toContain('usage:');
  });
});

describe('build-local.sh Rust toolchain check', () => {
  it('says rustup is not installed, without suggesting rustup target add, when rustup is absent', () => {
    const result = runBuildLocal({ arguments_: ['--target', ARM64_TARGET] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rustup is not installed');
    expect(result.stderr).not.toContain('command not found');
    expect(result.stderr).not.toContain('rustup target add');
  });

  it('names the missing Rust target and the command that installs it', () => {
    const stubFolder = writeRustupStub({ installedTargets: [ARM64_TARGET] });

    const result = runBuildLocal({ arguments_: ['--target', X64_TARGET], stubFolder });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the Rust target ${X64_TARGET} is missing, run: rustup target add ${X64_TARGET}`);
  });
});
