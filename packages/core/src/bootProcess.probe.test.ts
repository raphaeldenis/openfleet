import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { refuseBootOnFailure } from './bootFailure.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_MAIN = join(CORE_ROOT, 'src', 'main.ts');

interface Booted { child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function spawnDaemon(env: Record<string, string>, preload?: string): Booted {
  const args = ['--import', 'tsx', ...(preload ? ['--import', preload] : []), SRC_MAIN];
  const child = spawn(process.execPath, args, { cwd: CORE_ROOT, env: { ...process.env, ...env } });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk) => { out += chunk; });
  child.stderr!.on('data', (chunk) => { err += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, exited };
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const homeWith = (configJson?: string) => {
  const home = mkdtempSync(join(tmpdir(), 'of-probe-'));
  if (configJson !== undefined) writeFileSync(join(home, 'config.json'), configJson);
  return home;
};

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
const canConnect = (port: number) => new Promise<boolean>((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

describe('probe: valid boot then signal', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s after a valid boot exits 0 and frees the port', async (signal) => {
    const port = await freePort();
    const daemon = spawnDaemon({ OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: String(port) });
    await waitFor(() => daemon.stdout().includes('openfleet core listening on'), 'banner');

    daemon.child.kill(signal);
    const { code } = await daemon.exited;

    expect(code).toBe(0);
    expect(daemon.stdout()).toContain(`http://127.0.0.1:${port}`);
    expect(daemon.stderr()).toBe('');
    expect(await canConnect(port)).toBe(true);
  }, 40_000);
});

describe('probe: refused boots', () => {
  const cases: [string, () => { env: Record<string, string>; configPathHome?: string }][] = [
    ['maxAgeMinutes 0', () => ({ env: { OPENFLEET_HOME: homeWith('{"workingState":{"maxAgeMinutes":0}}') } })],
    ['heartbeatDefaultSeconds 0', () => ({ env: { OPENFLEET_HOME: homeWith('{"managers":{"heartbeatDefaultSeconds":0}}') } })],
    ['unknown key in section', () => ({ env: { OPENFLEET_HOME: homeWith('{"workingState":{"maxAgeMinuts":5}}') } })],
    ['unknown key in managers', () => ({ env: { OPENFLEET_HOME: homeWith('{"managers":{"nope":5}}') } })],
    ['invalid JSON', () => ({ env: { OPENFLEET_HOME: homeWith('{ not json') } })],
    ['catastrophic handoverPatterns', () => ({ env: { OPENFLEET_HOME: homeWith('{"workingState":{"handoverPatterns":["(a+)+$"]}}') } })],
    ['unreadable config.json', () => { const home = homeWith('{}'); chmodSync(join(home, 'config.json'), 0o000); return { env: { OPENFLEET_HOME: home } }; }],
    ['non-numeric port', () => ({ env: { OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: 'abc' } })],
    ['short admin token', () => { const home = homeWith(); writeFileSync(join(home, 'admin.token'), 'short'); return { env: { OPENFLEET_HOME: home } }; }],
    ['home is a file', () => { const home = homeWith(); const file = join(home, 'afile'); writeFileSync(file, 'x'); return { env: { OPENFLEET_HOME: join(file, 'sub') } }; }],
    ['home dir not writable', () => { const parent = homeWith(); chmodSync(parent, 0o500); return { env: { OPENFLEET_HOME: join(parent, 'home') } }; }],
    ['malformed models section', () => ({ env: { OPENFLEET_HOME: homeWith('{"models":{"haiku":123}}') } })],
  ];

  it.each(cases)('%s → exit 1, exactly one stderr line, no stack, no raw zod, port free', async (_name, build) => {
    const { env } = build();
    const port = await freePort();
    const daemon = spawnDaemon({ OPENFLEET_PORT: String(port), ...env });

    const { code } = await daemon.exited;

    const lines = daemon.stderr().trimEnd().split('\n');
    expect(code).toBe(1);
    expect(lines, daemon.stderr()).toHaveLength(1);
    expect(lines[0]).toMatch(/^openfleet: refusing to boot \(config: .*config\.json\): /);
    expect(daemon.stderr()).not.toMatch(/\n\s+at |Error:|"code"|"origin"|daemon continuing/);
    expect(daemon.stdout()).not.toContain('listening');
    expect(await canConnect(port)).toBe(true);
  }, 40_000);

  it('port already in use → exit 1, one stderr line, other listener untouched', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as { port: number };
    const daemon = spawnDaemon({ OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: String(port) });

    const { code } = await daemon.exited;

    expect(code).toBe(1);
    expect(daemon.stderr().trimEnd().split('\n')).toHaveLength(1);
    expect(daemon.stderr()).toContain('EADDRINUSE');
    expect(blocker.listening).toBe(true);
  }, 40_000);

});

describe('probe: boot ordering and reasons', () => {
  it('creates the database owner-only because process guards are installed before the boot', async () => {
    const home = homeWith();
    const port = await freePort();
    const daemon = spawnDaemon({ OPENFLEET_HOME: home, OPENFLEET_PORT: String(port) });
    await waitFor(() => daemon.stdout().includes('listening'), 'banner');

    const dbMode = statSync(join(home, 'openfleet.db')).mode & 0o777;
    daemon.child.kill('SIGTERM');
    await daemon.exited;

    expect(dbMode & 0o077).toBe(0);
  }, 40_000);

  it('names the offending models key on the refusal line instead of a zod dump opener', async () => {
    const daemon = spawnDaemon({ OPENFLEET_HOME: homeWith('{"models":{"haiku":123}}'), OPENFLEET_PORT: String(await freePort()) });

    await daemon.exited;

    expect(daemon.stderr()).toContain('models.haiku');
  }, 40_000);
});

describe('probe: runtime uncaught exception after boot', () => {
  it('logs "daemon continuing", keeps serving, and still shuts down cleanly', async () => {
    const preloadDir = mkdtempSync(join(tmpdir(), 'of-preload-'));
    const preload = join(preloadDir, 'throwLater.mjs');
    writeFileSync(preload, "setTimeout(() => { setTimeout(() => { throw new Error('boom-after-boot'); }, 10); }, 4000);\n");
    const port = await freePort();
    const daemon = spawnDaemon({ OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: String(port) }, preload);
    await waitFor(() => daemon.stdout().includes('listening'), 'banner');

    await waitFor(() => daemon.stderr().includes('uncaughtException: daemon continuing'), 'guard log');
    const stillAlive = daemon.child.exitCode === null;
    const stillListening = !(await canConnect(port));
    daemon.child.kill('SIGTERM');
    const { code } = await daemon.exited;

    expect(stillAlive).toBe(true);
    expect(stillListening).toBe(true);
    expect(code).toBe(0);
  }, 60_000);
});

describe('probe: fatal line secrecy', () => {
  const runRefusal = async (error: unknown) => {
    const written: string[] = [];
    await refuseBootOnFailure(async () => { throw error; }, { configPath: '/h/config.json', writeStderr: (t) => written.push(t), exit: () => { throw new Error('exit'); } }).catch(() => undefined);
    return written.join('');
  };

  it('does not print the stack or later lines of an error that carries a secret there', async () => {
    const error = new Error('bad settings\nadmin=SECRET-TOKEN-123');
    error.stack = 'Error: bad settings\n    at SECRET-TOKEN-123';

    const line = await runRefusal(error);

    expect(line).not.toContain('SECRET');
  });

  it('prints only the first line for a non-Error throw (a string carrying a secret on line 2)', async () => {
    const line = await runRefusal('boom\nSECRET-TOKEN-123');

    expect(line).not.toContain('SECRET');
  });

  it('survives a thrown undefined/null/object without throwing itself', async () => {
    expect(await runRefusal(undefined)).toContain('refusing to boot');
    expect(await runRefusal(null)).toContain('refusing to boot');
    expect(await runRefusal({ message: 'x' })).toContain('refusing to boot');
  });
});
