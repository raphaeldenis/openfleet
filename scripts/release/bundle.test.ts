import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const runBundle = (arguments_: string[]) => spawnSync(process.execPath, [SCRIPT, ...arguments_], { encoding: 'utf8', cwd: tmpdir() });
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
  it('writes daemon.mjs at the root of the output folder', () => {
    expect(statSync(join(arm64Out, 'daemon.mjs')).size).toBeGreaterThan(0);
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

    expect(health).toEqual({ ok: true, version: TEST_VERSION });
    expect(appliedCount).toBe(sqlFilesIn(SOURCE_MIGRATIONS).length);
    expect(exitCode).toBe(0);
  }, BOOT_TIMEOUT_MS);
});
