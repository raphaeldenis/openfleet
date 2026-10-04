import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('build-local.sh architecture checks', () => {
  function makeBuildFixture({ sidecarCpu, packagedCpu }: { sidecarCpu: number; packagedCpu: number }) {
    const root = makeScratchFolder();
    const releaseFolder = join(root, 'scripts/release');
    const toolsFolder = join(root, 'tools');
    const tauriFolder = join(root, 'apps/desktop/src-tauri');
    const bundleFolder = join(tauriFolder, `target/${ARM64_TARGET}/release/bundle`);
    const macosFolder = join(bundleFolder, 'macos/OpenFleet.app/Contents/MacOS');
    for (const folder of [releaseFolder, toolsFolder, join(tauriFolder, 'binaries'), macosFolder, join(bundleFolder, 'dmg')]) mkdirSync(folder, { recursive: true });
    cpSync(SCRIPT, join(releaseFolder, 'build-local.sh'));
    cpSync(join(dirname(SCRIPT), 'verify-architecture.mjs'), join(releaseFolder, 'verify-architecture.mjs'));
    writeFileSync(join(releaseFolder, 'node-version.txt'), '26.9.0');
    writeFileSync(join(tauriFolder, 'tauri.conf.json'), '{"version":"0.1.0"}');
    writeFileSync(join(bundleFolder, 'dmg/OpenFleet_0.1.0_aarch64.dmg'), 'synthetic dmg');
    function writeMachO({ path, cpu }: { path: string; cpu: number }) {
      const header = Buffer.alloc(32);
      header.writeUInt32LE(0xfeedfacf, 0);
      header.writeUInt32LE(cpu, 4);
      header.writeUInt32LE(2, 12);
      writeFileSync(path, header);
    }
    writeMachO({ path: join(tauriFolder, `binaries/node-${ARM64_TARGET}`), cpu: sidecarCpu });
    writeMachO({ path: join(macosFolder, 'node'), cpu: packagedCpu });
    writeMachO({ path: join(macosFolder, 'app'), cpu: 0x0100000c });
    const commandLog = join(root, 'commands.log');
    const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const stubs = {
      rustup: `printf '%s\\n' '${ARM64_TARGET}'`,
      node: `case "$1" in *fetch-node.mjs) exit 0 ;; esac\nexec ${quotedNode} "$@"`,
      pnpm: `printf '%s\\n' "$*" >> '${commandLog}'`,
    };
    for (const [name, source] of Object.entries(stubs)) {
      const path = join(toolsFolder, name);
      writeFileSync(path, `#!/bin/sh\n${source}\n`);
      chmodSync(path, 0o755);
    }
    const result = spawnSync('/bin/bash', [join(releaseFolder, 'build-local.sh')], {
      encoding: 'utf8',
      env: { PATH: `${toolsFolder}:${SYSTEM_PATH}`, OPENFLEET_BUILD_EXTRA_PATH: '', HOME: root },
    });
    return { result, commandLog };
  }

  it('stops before bundling when the downloaded Node has the wrong CPU', () => {
    const { result } = makeBuildFixture({ sidecarCpu: 0x01000007, packagedCpu: 0x0100000c });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is x86_64, expected arm64');
    expect(result.stdout).not.toContain('dmg:');
  });

  it('refuses success when Tauri packages a Node for the wrong CPU', () => {
    const { result, commandLog } = makeBuildFixture({ sidecarCpu: 0x0100000c, packagedCpu: 0x01000007 });

    expect(result.status).toBe(1);
    expect(readFileSync(commandLog, 'utf8')).toContain(`tauri build --target ${ARM64_TARGET}`);
    expect(result.stderr).toContain('is x86_64, expected arm64');
    expect(result.stdout).not.toContain('dmg:');
  });

  it('reports the dmg when source and packaged executables match the target', () => {
    const { result } = makeBuildFixture({ sidecarCpu: 0x0100000c, packagedCpu: 0x0100000c });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OpenFleet_0.1.0_aarch64.dmg');
  });
});
