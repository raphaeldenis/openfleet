import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirTracker } from './tempDirTracker.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_MAIN = join(CORE_ROOT, 'src', 'main.ts');
const MAX_BOOT_ATTEMPTS = 3;
const FILE_MODE_MASK = 0o777;

interface Booted { child: ChildProcess; stdout: () => string; exited: Promise<{ code: number | null }> }

const tempDirs = createTempDirTracker();
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  tempDirs.removeAll();
});

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Throws an uncaught exception from a timer at each of the given delays after the daemon listens. */
function throwingPreload(delaysMs: number[]): string {
  const preload = join(tempDirs.make('of-preload-'), 'escapes.mjs');
  writeFileSync(preload, `
    const { log } = console;
    console.log = (...args) => { log(...args); if (String(args[0]).includes('listening')) ${JSON.stringify(delaysMs)}.forEach((ms, index) => setTimeout(() => { throw new Error('escaped ' + index); }, ms)); };
  `);
  return preload;
}

async function bootWithEscapes(home: string, delaysMs: number[]): Promise<{ daemon: Booted; port: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', throwingPreload(delaysMs), SRC_MAIN], { cwd: CORE_ROOT, env: { ...process.env, OPENFLEET_HOME: home, OPENFLEET_PORT: String(port) } });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout!.on('data', (chunk) => { out += chunk; });
    child.stderr!.on('data', (chunk) => { err += chunk; });
    const exited = new Promise<{ code: number | null }>((resolve) => child.on('close', (code) => resolve({ code })));
    const daemon: Booted = { child, stdout: () => out, exited };
    await waitFor(() => out.includes('listening') || child.exitCode !== null, 'the boot to settle');
    const lostThePortRace = err.includes('is already in use') && attempt < MAX_BOOT_ATTEMPTS;
    if (!lostThePortRace) return { daemon, port };
    await exited;
  }
}

const crashFilesIn = (home: string) => readdirSync(join(home, 'crashes')).sort();

describe('probe: a real daemon that meets an escaped exception (ERR-06)', () => {
  it('keeps answering /health 200 ok with status degraded, and leaves one owner-only crash file', async () => {
    const home = tempDirs.make('of-probe-');
    const { daemon, port } = await bootWithEscapes(home, [200]);
    const healthNow = () => fetch(`http://127.0.0.1:${port}/health`);
    await vi.waitFor(async () => expect(((await (await healthNow()).json()) as { status: string }).status).toBe('degraded'), { timeout: 10_000, interval: 100 });

    const health = await healthNow();

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, status: 'degraded', issues: 1 });
    expect(daemon.child.exitCode).toBeNull();
    const [crashFile] = crashFilesIn(home);
    expect(crashFilesIn(home)).toHaveLength(1);
    expect(statSync(join(home, 'crashes', crashFile!)).mode & FILE_MODE_MASK).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, 'crashes', crashFile!), 'utf8'))).toMatchObject({ reason: 'uncaught_exception', health: { status: 'degraded' } });
  }, 40_000);

  it('exits 2 on a second escaped exception within a minute, leaving the crash files of both', async () => {
    const home = tempDirs.make('of-probe-');
    const { daemon } = await bootWithEscapes(home, [200, 600]);

    const { code } = await daemon.exited;

    expect(code).toBe(2);
    expect(crashFilesIn(home)).toHaveLength(2);
  }, 40_000);
});
