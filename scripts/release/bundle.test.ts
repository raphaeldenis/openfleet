import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeUnsupportedNode } from './bundle-daemon.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'bundle-daemon.mjs');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_MIGRATIONS = join(REPO_ROOT, 'packages/core/src/db/migrations');
const SOURCE_NODE_PTY_PREBUILDS = join(REPO_ROOT, 'packages/core/node_modules/node-pty/prebuilds');

const TEST_VERSION = '9.9.9';
const ARM64_TARGET = 'aarch64-apple-darwin';
const X64_TARGET = 'x86_64-apple-darwin';
const SECONDS = 1000;
const BOOT_TIMEOUT_MS = 30 * SECONDS;
const SHUTDOWN_TIMEOUT_MS = 8 * SECONDS;
const OWNER_EXECUTE_BIT = 0o100;
const SPAWN_HELPER_MODE = 0o755;

const scratchFolders: string[] = [];
const makeScratchFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'of-bundle-'));
  scratchFolders.push(folder);
  return folder;
};

const writeTauriConf = (folder: string, version: string) => {
  const path = join(folder, 'tauri.conf.json');
  writeFileSync(path, JSON.stringify({ productName: 'OpenFleet', version }));
  return path;
};

const MARKER_NAME = '.openfleet-daemon-bundle';
const BUNDLE_ENTRIES = ['daemon.bundle.mjs', 'daemon.mjs', 'migrations', 'node_modules'];

const runBundle = (arguments_: string[], env?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [SCRIPT, ...arguments_], { encoding: 'utf8', cwd: tmpdir(), env });
const bundleInto = (out: string) => runBundle(['--target', ARM64_TARGET, '--out', out, '--tauri-conf', tauriConf]);
const topLevelEntriesIn = (folder: string) => readdirSync(folder).sort();
const sqlFilesIn = (folder: string) => readdirSync(folder).filter((name) => name.endsWith('.sql')).sort();
const prebuildFoldersIn = (out: string) => readdirSync(join(out, 'node_modules/node-pty/prebuilds')).sort();

let scratch: string;
let tauriConf: string;
let arm64Out: string;

beforeAll(() => {
  scratch = makeScratchFolder();
  tauriConf = writeTauriConf(scratch, TEST_VERSION);
  arm64Out = join(scratch, 'arm64');
  const result = runBundle(['--target', ARM64_TARGET, '--out', arm64Out, '--tauri-conf', tauriConf]);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, BOOT_TIMEOUT_MS);

afterAll(() => {
  for (const folder of scratchFolders) rmSync(folder, { recursive: true, force: true });
});

describe('bundle layout', () => {
  it('writes the daemon.mjs launcher, the daemon.bundle.mjs bundle and the marker, and nothing else at the top level besides migrations and node_modules', () => {
    expect(statSync(join(arm64Out, 'daemon.mjs')).size).toBeGreaterThan(0);
    expect(statSync(join(arm64Out, 'daemon.bundle.mjs')).size).toBeGreaterThan(0);
    expect(topLevelEntriesIn(arm64Out)).toEqual([MARKER_NAME, ...BUNDLE_ENTRIES].sort());
  });

  it('records the target and every top-level entry it wrote in the marker', () => {
    const marker = JSON.parse(readFileSync(join(arm64Out, MARKER_NAME), 'utf8'));

    expect(marker.target).toBe(ARM64_TARGET);
    expect([...marker.entries].sort()).toEqual(BUNDLE_ENTRIES);
  });

  it('copies every migration byte for byte and no other file', () => {
    const shipped = sqlFilesIn(join(arm64Out, 'migrations'));

    expect(shipped).toEqual(sqlFilesIn(SOURCE_MIGRATIONS));
    for (const name of shipped) {
      expect(readFileSync(join(arm64Out, 'migrations', name)).equals(readFileSync(join(SOURCE_MIGRATIONS, name)))).toBe(true);
    }
  });

  it('ships node-pty with its package.json, lib and only the target prebuilds', () => {
    const nodePty = join(arm64Out, 'node_modules/node-pty');

    expect(existsSync(join(nodePty, 'package.json'))).toBe(true);
    expect(existsSync(join(nodePty, 'lib/index.js'))).toBe(true);
    expect(prebuildFoldersIn(arm64Out)).toEqual(['darwin-arm64']);
    expect(existsSync(join(nodePty, 'prebuilds/darwin-arm64/pty.node'))).toBe(true);
  });

  it('makes spawn-helper mode 755', () => {
    const mode = statSync(join(arm64Out, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).mode & 0o777;

    expect(mode).toBe(SPAWN_HELPER_MODE);
  });
});

describe('second target', () => {
  const hasX64Prebuild = existsSync(join(SOURCE_NODE_PTY_PREBUILDS, 'darwin-x64'));

  it.skipIf(!hasX64Prebuild)('ships the darwin-x64 prebuilds only for x86_64-apple-darwin', () => {
    const x64Out = join(makeScratchFolder(), 'x64');

    const result = runBundle(['--target', X64_TARGET, '--out', x64Out, '--tauri-conf', tauriConf]);

    expect(result.status).toBe(0);
    expect(prebuildFoldersIn(x64Out)).toEqual(['darwin-x64']);
    expect(statSync(join(x64Out, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper')).mode & OWNER_EXECUTE_BIT).toBeTruthy();
  }, BOOT_TIMEOUT_MS);

  if (!hasX64Prebuild) it('SKIPPED: node-pty ships no darwin-x64 prebuild in this install', () => {});
});

describe('node-pty prebuild guard', () => {
  const MACH_O_64_MAGIC = 0xfeedfacf;
  const CPU_TYPE_X86_64 = 0x01000007;
  const CPU_TYPE_ARM64 = 0x0100000c;

  const machOHeader = (cpuType: number) => {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(MACH_O_64_MAGIC, 0);
    header.writeUInt32LE(cpuType, 4);
    return header;
  };

  const writeFakeNodePty = ({ prebuildCpuType, withPrebuild = true }: { prebuildCpuType: number; withPrebuild?: boolean }) => {
    const nodePtyFolder = join(makeScratchFolder(), 'node-pty');
    mkdirSync(join(nodePtyFolder, 'lib'), { recursive: true });
    writeFileSync(join(nodePtyFolder, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
    writeFileSync(join(nodePtyFolder, 'lib/index.js'), '');
    if (withPrebuild) {
      const prebuildFolder = join(nodePtyFolder, 'prebuilds/darwin-x64');
      mkdirSync(prebuildFolder, { recursive: true });
      writeFileSync(join(prebuildFolder, 'pty.node'), machOHeader(prebuildCpuType));
      writeFileSync(join(prebuildFolder, 'spawn-helper'), machOHeader(prebuildCpuType));
    }
    return nodePtyFolder;
  };

  const previousBundleOut = () => {
    const out = join(makeScratchFolder(), 'previous');
    cpSync(arm64Out, out, { recursive: true });
    return out;
  };

  const bundleX64With = ({ nodePtyDir, out }: { nodePtyDir: string; out: string }) =>
    runBundle(['--target', X64_TARGET, '--out', out, '--tauri-conf', tauriConf, '--node-pty-dir', nodePtyDir]);

  it('bundles a node-pty whose darwin-x64 prebuild is a x86_64 Mach-O and ships only that prebuild', () => {
    const out = join(makeScratchFolder(), 'x64');

    const result = bundleX64With({ nodePtyDir: writeFakeNodePty({ prebuildCpuType: CPU_TYPE_X86_64 }), out });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(prebuildFoldersIn(out)).toEqual(['darwin-x64']);
  }, BOOT_TIMEOUT_MS);

  it('fails loudly and keeps the previous bundle when node-pty has no darwin-x64 prebuild', () => {
    const out = previousBundleOut();

    const result = bundleX64With({ nodePtyDir: writeFakeNodePty({ prebuildCpuType: CPU_TYPE_X86_64, withPrebuild: false }), out });

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('darwin-x64');
    expect(prebuildFoldersIn(out)).toEqual(['darwin-arm64']);
  }, BOOT_TIMEOUT_MS);

  it('fails loudly and keeps the previous bundle when the darwin-x64 prebuild is an arm64 Mach-O', () => {
    const out = previousBundleOut();

    const result = bundleX64With({ nodePtyDir: writeFakeNodePty({ prebuildCpuType: CPU_TYPE_ARM64 }), out });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/arm64/);
    expect(result.stderr).toContain('x86_64-apple-darwin');
    expect(prebuildFoldersIn(out)).toEqual(['darwin-arm64']);
  }, BOOT_TIMEOUT_MS);
});

describe('unknown target', () => {
  it('is refused with a one-line error and nothing is written', () => {
    const out = join(makeScratchFolder(), 'never-created');

    const result = runBundle(['--target', 'riscv64-unknown-linux-gnu', '--out', out, '--tauri-conf', tauriConf]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('riscv64-unknown-linux-gnu');
    expect(existsSync(out)).toBe(false);
  });
});

describe('an output folder that holds other people\'s files', () => {
  it('never deletes a node_modules or a file it did not write', () => {
    const out = join(makeScratchFolder(), 'shared-folder');
    const foreignModule = join(out, 'node_modules/someone-elses-package/index.js');
    const foreignNote = join(out, 'notes.txt');
    mkdirSync(dirname(foreignModule), { recursive: true });
    writeFileSync(foreignModule, 'module.exports = 1;');
    writeFileSync(foreignNote, 'keep me');

    runBundle(['--target', ARM64_TARGET, '--out', out, '--tauri-conf', tauriConf]);

    expect(existsSync(foreignModule)).toBe(true);
    expect(readFileSync(foreignNote, 'utf8')).toBe('keep me');
  }, BOOT_TIMEOUT_MS);

  it('refuses a non-empty folder it did not write, in one line, and changes nothing', () => {
    const out = join(makeScratchFolder(), 'unmarked');
    mkdirSync(join(out, 'node_modules/keepme'), { recursive: true });
    writeFileSync(join(out, 'daemon.mjs'), 'someone elses daemon');

    const result = bundleInto(out);

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(out);
    expect(topLevelEntriesIn(out)).toEqual(['daemon.mjs', 'node_modules']);
    expect(readFileSync(join(out, 'daemon.mjs'), 'utf8')).toBe('someone elses daemon');
    expect(existsSync(join(out, 'node_modules/keepme'))).toBe(true);
  });

  it('bundles into an existing empty folder', () => {
    const out = join(makeScratchFolder(), 'empty');
    mkdirSync(out);

    const result = bundleInto(out);

    expect(result.status).toBe(0);
    expect(existsSync(join(out, 'daemon.bundle.mjs'))).toBe(true);
  }, BOOT_TIMEOUT_MS);

  it('replaces exactly the previous bundle on a second run and leaves foreign files alone', () => {
    const out = join(makeScratchFolder(), 'rerun');
    bundleInto(out);
    writeFileSync(join(out, 'notes.txt'), 'keep me');
    writeFileSync(join(out, 'migrations/stale-from-previous-run.sql'), 'select 1;');
    writeFileSync(join(out, 'node_modules/node-pty/stale.txt'), 'stale');

    const result = bundleInto(out);

    expect(result.status).toBe(0);
    expect(topLevelEntriesIn(out)).toEqual([MARKER_NAME, 'notes.txt', ...BUNDLE_ENTRIES].sort());
    expect(readFileSync(join(out, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(out, 'migrations/stale-from-previous-run.sql'))).toBe(false);
    expect(existsSync(join(out, 'node_modules/node-pty/stale.txt'))).toBe(false);
    expect(sqlFilesIn(join(out, 'migrations'))).toEqual(sqlFilesIn(SOURCE_MIGRATIONS));
  }, BOOT_TIMEOUT_MS);

  it('trusts only the entries it knows how to write when the marker is tampered with', () => {
    const out = join(makeScratchFolder(), 'tampered');
    mkdirSync(join(out, 'precious'), { recursive: true });
    writeFileSync(join(out, MARKER_NAME), JSON.stringify({ entries: ['precious'] }));

    const result = bundleInto(out);

    expect(result.status).toBe(1);
    expect(existsSync(join(out, 'precious'))).toBe(true);
  });

  it('refuses an output folder that is a symbolic link and leaves its target alone', () => {
    const scratchFolder = makeScratchFolder();
    const target = join(scratchFolder, 'real-target');
    mkdirSync(target);
    const link = join(scratchFolder, 'link');
    symlinkSync(target, link);

    const result = bundleInto(link);

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(readdirSync(target)).toEqual([]);
  });
});

describe('a protected output folder', () => {
  const fakeHomeEnv = (home: string) => ({ ...process.env, HOME: home });

  it('refuses the home folder even when it is empty, and writes nothing into it', () => {
    const home = makeScratchFolder();

    const result = runBundle(['--target', ARM64_TARGET, '--out', home, '--tauri-conf', tauriConf], fakeHomeEnv(home));

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses the repository root and deletes nothing in it', () => {
    const result = bundleInto(REPO_ROOT);

    expect(result.status).toBe(1);
    expect(existsSync(join(REPO_ROOT, MARKER_NAME))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);
  });

  it('refuses the filesystem root and writes nothing into it', () => {
    const result = bundleInto('/');

    expect(result.status).toBe(1);
    expect(existsSync(`/${MARKER_NAME}`)).toBe(false);
    expect(existsSync('/daemon.bundle.mjs')).toBe(false);
  });

  it('refuses a folder that contains the scripts folder', () => {
    const result = bundleInto(join(REPO_ROOT, 'scripts', '..'));

    expect(result.status).toBe(1);
    expect(existsSync(join(REPO_ROOT, MARKER_NAME))).toBe(false);
  });
});

describe('a tauri.conf.json without a usable version', () => {
  it('fails in one line and leaves the previous bundle untouched', () => {
    const previousDaemon = readFileSync(join(arm64Out, 'daemon.mjs'));
    const versionlessConf = join(makeScratchFolder(), 'tauri.conf.json');
    writeFileSync(versionlessConf, JSON.stringify({ productName: 'OpenFleet' }));

    const result = runBundle(['--target', ARM64_TARGET, '--out', arm64Out, '--tauri-conf', versionlessConf]);

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(arm64Out, 'daemon.mjs')).equals(previousDaemon)).toBe(true);
  });
});

describe('reproducibility', () => {
  it('produces the same daemon.mjs whatever the working directory of the build', () => {
    const fromTmp = join(makeScratchFolder(), 'from-tmp');
    const fromRepo = join(makeScratchFolder(), 'from-repo');

    spawnSync(process.execPath, [SCRIPT, '--target', ARM64_TARGET, '--out', fromTmp, '--tauri-conf', tauriConf], { cwd: tmpdir() });
    spawnSync(process.execPath, [SCRIPT, '--target', ARM64_TARGET, '--out', fromRepo, '--tauri-conf', tauriConf], { cwd: REPO_ROOT });

    for (const name of ['daemon.mjs', 'daemon.bundle.mjs']) {
      expect(readFileSync(join(fromRepo, name)).equals(readFileSync(join(fromTmp, name)))).toBe(true);
    }
  }, BOOT_TIMEOUT_MS);

  it('produces the same bundle whatever the depth of the output folder', () => {
    const deepOut = join(makeScratchFolder(), 'a', 'b', 'c', 'deep');
    mkdirSync(dirname(deepOut), { recursive: true });

    bundleInto(deepOut);

    expect(readFileSync(join(deepOut, 'daemon.bundle.mjs')).equals(readFileSync(join(arm64Out, 'daemon.bundle.mjs')))).toBe(true);
  }, BOOT_TIMEOUT_MS);

  it('embeds no machine path in the bundle, its inline sourcemap or the launcher', () => {
    const machinePaths = [REPO_ROOT, tmpdir(), process.env.HOME ?? REPO_ROOT];
    const sourcemapBase64 = /sourceMappingURL=data:application\/json;base64,(\S+)/.exec(readFileSync(join(arm64Out, 'daemon.bundle.mjs'), 'utf8'))![1]!;
    const sourcemap = Buffer.from(sourcemapBase64, 'base64').toString('utf8');

    for (const content of [readFileSync(join(arm64Out, 'daemon.bundle.mjs'), 'utf8'), sourcemap, readFileSync(join(arm64Out, 'daemon.mjs'), 'utf8')]) {
      for (const machinePath of machinePaths) expect(content).not.toContain(machinePath);
    }
  });
});

describe('the node version guard', () => {
  const engineMinimumMajor = Number(/>=\s*(\d+)/.exec(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).engines.node)![1]);

  it('says in one line which Node the daemon needs and which it found', () => {
    expect(describeUnsupportedNode('22.4.1', 26)).toBe('openfleet: the daemon needs Node 26 or newer (found 22.4.1)');
  });

  it('accepts the minimum major and anything newer', () => {
    expect(describeUnsupportedNode('26.0.0', 26)).toBe('');
    expect(describeUnsupportedNode('27.1.0', 26)).toBe('');
  });

  it('demands exactly the Node major the repository engines field requires', () => {
    const launcher = readFileSync(join(arm64Out, 'daemon.mjs'), 'utf8');

    expect(launcher).toContain(`describeUnsupportedNode(process.versions.node, ${engineMinimumMajor})`);
  });

  it('runs before anything is imported: the launcher has a single dynamic import and no static import', () => {
    const launcher = readFileSync(join(arm64Out, 'daemon.mjs'), 'utf8');

    expect(launcher).not.toMatch(/^\s*import\s/m);
    expect(launcher.match(/import\(/g)).toHaveLength(1);
    expect(launcher).toContain("await import('./daemon.bundle.mjs')");
  });

  // Booting the launcher on a genuinely old Node is not possible here (process.versions is read-only and no old Node is installed), so the guard is covered by the unit tests above.
});

describe('the flags after a bare "--"', () => {
  it('are accepted as if the separator were absent', () => {
    const out = join(makeScratchFolder(), 'after-separator');

    const result = runBundle(['--', '--target', ARM64_TARGET, '--out', out, '--tauri-conf', tauriConf]);

    expect(result.stderr).toBe('');
    expect(existsSync(join(out, 'daemon.bundle.mjs'))).toBe(true);
  }, BOOT_TIMEOUT_MS);
});

describe('the spawn-helper permissions', () => {
  it('are set to 755 in the output whatever the mode in the node-pty folder', () => {
    const nodePtyCopy = join(makeScratchFolder(), 'node-pty');
    const sourceNodePty = join(REPO_ROOT, 'packages/core/node_modules/node-pty');
    cpSync(sourceNodePty, nodePtyCopy, { recursive: true, dereference: true });
    const copiedHelper = join(nodePtyCopy, 'prebuilds/darwin-arm64/spawn-helper');
    chmodSync(copiedHelper, 0o644);
    const out = join(makeScratchFolder(), 'chmod');

    const result = runBundle(['--target', ARM64_TARGET, '--out', out, '--tauri-conf', tauriConf, '--node-pty-dir', nodePtyCopy]);

    expect(result.status).toBe(0);
    expect(statSync(join(out, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(SPAWN_HELPER_MODE);
    expect(statSync(copiedHelper).mode & 0o777).toBe(0o644);
  }, BOOT_TIMEOUT_MS);
});

describe('the documented pnpm command', () => {
  it('accepts the flags after pnpm\'s "--" separator', () => {
    const out = join(makeScratchFolder(), 'via-pnpm');

    const result = spawnSync('pnpm', ['--dir', REPO_ROOT, '--filter', '@openfleet/core', 'bundle', '--', '--target', X64_TARGET, '--out', out, '--tauri-conf', tauriConf], { encoding: 'utf8', cwd: tmpdir() });

    expect(result.stderr).not.toContain('unknown argument');
    expect(existsSync(join(out, 'daemon.mjs'))).toBe(true);
  }, BOOT_TIMEOUT_MS);
});

describe('the bundled daemon', () => {
  const LISTENING_LINE = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
  let daemon: ChildProcess | undefined;

  afterAll(() => {
    daemon?.kill('SIGKILL');
  });

  const waitForListeningUrl = (child: ChildProcess) =>
    new Promise<string>((resolve, reject) => {
      let output = '';
      const onOutput = (chunk: Buffer) => {
        output += chunk.toString();
        const match = LISTENING_LINE.exec(output);
        if (match) resolve(match[1]!);
      };
      child.stdout!.on('data', onOutput);
      child.stderr!.on('data', onOutput);
      child.once('exit', (code) => reject(new Error(`daemon exited with ${code} before listening:\n${output}`)));
    });

  it('boots outside the repo, reports the baked version, applies every migration and stops cleanly on SIGTERM', async () => {
    const home = join(makeScratchFolder(), 'home');
    mkdirSync(home);
    const outsideTheRepo = makeScratchFolder();
    const scrubbedEnv = { OPENFLEET_HOME: home, OPENFLEET_PORT: '0', HOME: outsideTheRepo, PATH: dirname(process.execPath) };
    daemon = spawn(process.execPath, [join(arm64Out, 'daemon.mjs')], { cwd: outsideTheRepo, env: scrubbedEnv });
    const exited = new Promise<number | null>((resolve) => daemon!.once('exit', (code) => resolve(code)));

    const url = await waitForListeningUrl(daemon);
    const health = await (await fetch(`${url}/health`)).json();
    const database = new DatabaseSync(join(home, 'openfleet.db'), { readOnly: true });
    const appliedCount = (database.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count;
    database.close();
    daemon.kill('SIGTERM');
    const exitCode = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS))]);

    expect(health).toEqual({ ok: true, version: TEST_VERSION, status: 'ok', issues: 0 });
    expect(appliedCount).toBe(sqlFilesIn(SOURCE_MIGRATIONS).length);
    expect(exitCode).toBe(0);
  }, BOOT_TIMEOUT_MS);
});
