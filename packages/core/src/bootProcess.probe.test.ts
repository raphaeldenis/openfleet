import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { refuseBootOnFailure } from './bootFailure.js';
import { createTempDirTracker } from './tempDirTracker.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_MAIN = join(CORE_ROOT, 'src', 'main.ts');

interface Booted { child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

const tempDirs = createTempDirTracker();
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  tempDirs.removeAll();
});

function spawnDaemon(env: Record<string, string>, preload?: string): Booted {
  const args = ['--import', 'tsx', ...(preload ? ['--import', preload] : []), SRC_MAIN];
  const child = spawn(process.execPath, args, { cwd: CORE_ROOT, env: { ...process.env, ...env } });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk) => { out += chunk; });
  child.stderr!.on('data', (chunk) => { err += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
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
  const home = tempDirs.make('of-probe-');
  if (configJson !== undefined) writeFileSync(join(home, 'config.json'), configJson);
  return home;
};

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
const canConnect = (port: number) => new Promise<boolean>((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

const MAX_BOOT_ATTEMPTS = 3;
const hasSettled = (daemon: Booted) => daemon.stdout().includes('listening') || daemon.child.exitCode !== null || daemon.child.signalCode !== null;

// A free port is only free until another process binds it, so a boot that loses that race is tried again.
async function bootOnFreePort(env: Record<string, string>, preload?: string): Promise<{ daemon: Booted; port: number }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const daemon = spawnDaemon({ OPENFLEET_PORT: String(port), ...env }, preload);
    await waitFor(() => hasSettled(daemon), 'the boot to settle');
    const lostThePortRace = daemon.stderr().includes('is already in use') && attempt < MAX_BOOT_ATTEMPTS;
    if (!lostThePortRace) return { daemon, port };
    await daemon.exited;
  }
}

describe('probe: valid boot then signal', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s after a valid boot exits 0 and frees the port', async (signal) => {
    const { daemon, port } = await bootOnFreePort({ OPENFLEET_HOME: homeWith() });
    await waitFor(() => daemon.stdout().includes('openfleet core listening on'), 'banner');

    daemon.child.kill(signal);
    const { code } = await daemon.exited;

    expect(code).toBe(0);
    expect(daemon.stdout()).toContain(`http://127.0.0.1:${port}`);
    expect(daemon.stderr()).toBe('');
    expect(await canConnect(port)).toBe(true);
  }, 40_000);
});

describe('probe: signal while the sessions are still resuming', () => {
  const SESSION_SERVICE = pathToFileURL(join(CORE_ROOT, 'src', 'sessions', 'sessionService.ts')).href;
  const RESUME_DURATION_MS = 1500;
  const slowResumePreload = () => {
    const preload = join(tempDirs.make('of-preload-'), 'slowResume.mjs');
    writeFileSync(preload, `
      import { SessionService } from ${JSON.stringify(SESSION_SERVICE)};
      const { resumeAll, closeAll } = SessionService.prototype;
      SessionService.prototype.resumeAll = async function (...args) {
        console.log('resumeAll started');
        await new Promise((resolve) => setTimeout(resolve, ${RESUME_DURATION_MS}));
        return resumeAll.apply(this, args);
      };
      SessionService.prototype.closeAll = function (...args) {
        console.log('closeAll called');
        return closeAll.apply(this, args);
      };
    `);
    return preload;
  };

  it.each(['SIGTERM', 'SIGINT'] as const)('%s during the resume exits 0 after closing the sessions and freeing the port', async (signal) => {
    const { daemon, port } = await bootOnFreePort({ OPENFLEET_HOME: homeWith() }, slowResumePreload());
    await waitFor(() => daemon.stdout().includes('resumeAll started'), 'the resume to start');

    daemon.child.kill(signal);
    const { code, signal: killedBy } = await daemon.exited;

    expect(killedBy).toBeNull();
    expect(code).toBe(0);
    expect(daemon.stdout()).toContain('closeAll called');
    expect(daemon.stderr()).toBe('');
    expect(await canConnect(port)).toBe(true);
  }, 40_000);
});

describe('probe: refused boots', () => {
  const CONFIG_LINE = /^openfleet: refusing to boot \(config: .*config\.json\): /;
  const GENERIC_LINE = /^openfleet: refusing to boot: /;
  const cases: [string, RegExp, () => { env: Record<string, string> }][] = [
    ['maxAgeMinutes 0', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{"workingState":{"maxAgeMinutes":0}}') } })],
    ['heartbeatDefaultSeconds 0', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{"managers":{"heartbeatDefaultSeconds":0}}') } })],
    ['unknown key in section', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{"workingState":{"maxAgeMinuts":5}}') } })],
    ['unknown key in managers', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{"managers":{"nope":5}}') } })],
    ['invalid JSON', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{ not json') } })],
    ['catastrophic handoverPatterns', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{"workingState":{"handoverPatterns":["(a+)+$"]}}') } })],
    ['unreadable config.json', CONFIG_LINE, () => { const home = homeWith('{}'); chmodSync(join(home, 'config.json'), 0o000); return { env: { OPENFLEET_HOME: home } }; }],
    ['malformed models section', CONFIG_LINE, () => ({ env: { OPENFLEET_HOME: homeWith('{"models":{"haiku":123}}') } })],
    ['non-numeric port', GENERIC_LINE, () => ({ env: { OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: 'abc' } })],
    ['short admin token', GENERIC_LINE, () => { const home = homeWith(); writeFileSync(join(home, 'admin.token'), 'short'); return { env: { OPENFLEET_HOME: home } }; }],
    ['home is a file', GENERIC_LINE, () => { const home = homeWith(); const file = join(home, 'afile'); writeFileSync(file, 'x'); return { env: { OPENFLEET_HOME: join(file, 'sub') } }; }],
    ['database file that cannot be opened', GENERIC_LINE, () => { const home = homeWith(); mkdirSync(join(home, 'openfleet.db')); return { env: { OPENFLEET_HOME: home } }; }],
    ['home dir not writable', GENERIC_LINE, () => { const parent = homeWith(); chmodSync(parent, 0o500); return { env: { OPENFLEET_HOME: join(parent, 'home') } }; }],
  ];

  it.each(cases)('%s → exit 1, exactly one line, no stack, no raw zod, port free', async (_name, expectedLine, build) => {
    const { env } = build();
    const { daemon, port } = await bootOnFreePort(env);

    const { code } = await daemon.exited;

    const lines = daemon.stderr().trimEnd().split('\n');
    expect(code).toBe(1);
    expect(lines, daemon.stderr()).toHaveLength(1);
    expect(lines[0]).toMatch(expectedLine);
    expect(daemon.stderr()).not.toMatch(/\n\s+at |Error:|"code"|"origin"|daemon continuing/);
    expect(daemon.stdout()).not.toContain('listening');
    expect(await canConnect(port)).toBe(true);
  }, 40_000);

  it('a database file that cannot be opened → names its path and asks to check its permissions', async () => {
    const home = homeWith();
    mkdirSync(join(home, 'openfleet.db'));
    const { daemon } = await bootOnFreePort({ OPENFLEET_HOME: home });

    await daemon.exited;

    expect(daemon.stderr()).toContain(`(check the permissions of ${join(home, 'openfleet.db')})`);
  }, 40_000);

  it('an OPENFLEET_PORT that is not a number → says how to set it, without blaming config.json', async () => {
    const daemon = spawnDaemon({ OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: 'abc' });

    await daemon.exited;

    expect(daemon.stderr()).toContain('set OPENFLEET_PORT to a port between 0 and 65535');
    expect(daemon.stderr()).not.toContain('config');
  }, 40_000);

  it('port already in use → exit 1, one stderr line naming the port and how to recover, other listener untouched', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as { port: number };
    const daemon = spawnDaemon({ OPENFLEET_HOME: homeWith(), OPENFLEET_PORT: String(port) });

    const { code } = await daemon.exited;

    expect(code).toBe(1);
    expect(daemon.stderr()).toBe(`openfleet: refusing to boot: port ${port} is already in use (stop the other process or set OPENFLEET_PORT)\n`);
    expect(blocker.listening).toBe(true);
  }, 40_000);

  it('a failure after the server listens (a stale launch directory that cannot be swept) → exit 1, one line naming the path to check, port free', async () => {
    const home = homeWith();
    const lockedDirectory = join(home, 'sessions', 'stale-session', 'locked');
    mkdirSync(lockedDirectory, { recursive: true });
    writeFileSync(join(lockedDirectory, 'settings.json'), '{}');
    chmodSync(lockedDirectory, 0o500);
    const { daemon, port } = await bootOnFreePort({ OPENFLEET_HOME: home });

    const { code } = await daemon.exited;

    const lines = daemon.stderr().trimEnd().split('\n');
    expect(code).toBe(1);
    expect(lines, daemon.stderr()).toHaveLength(1);
    expect(lines[0]).toMatch(/^openfleet: refusing to boot: /);
    expect(lines[0]).toContain('check the permissions of');
    expect(lines[0]).not.toContain('config');
    expect(daemon.stdout()).toContain('listening');
    expect(await canConnect(port)).toBe(true);
  }, 40_000);
});

describe('probe: boot ordering and reasons', () => {
  it('creates the home with the owner-only umask already in place because process guards are installed before the boot', async () => {
    const umaskFile = join(tempDirs.make('of-umask-'), 'umask-at-home-creation');
    const preload = join(tempDirs.make('of-preload-'), 'recordUmask.mjs');
    writeFileSync(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const mkdirSync = fs.mkdirSync;
      const writeFileSync = fs.writeFileSync;
      let recorded = false;
      fs.mkdirSync = (...args) => {
        if (!recorded) { recorded = true; writeFileSync(${JSON.stringify(umaskFile)}, process.umask().toString(8)); }
        return mkdirSync(...args);
      };
      syncBuiltinESMExports();
    `);
    const { daemon } = await bootOnFreePort({ OPENFLEET_HOME: homeWith() }, preload);
    await waitFor(() => daemon.stdout().includes('listening'), 'banner');
    daemon.child.kill('SIGTERM');
    await daemon.exited;

    expect(readFileSync(umaskFile, 'utf8')).toBe('77');
  }, 40_000);

  it('names the offending models key on the refusal line instead of a zod dump opener', async () => {
    const { daemon } = await bootOnFreePort({ OPENFLEET_HOME: homeWith('{"models":{"haiku":123}}') });

    await daemon.exited;

    expect(daemon.stderr()).toContain('models.haiku');
  }, 40_000);
});

describe('probe: runtime uncaught exception after boot', () => {
  it('logs "daemon continuing", keeps serving, and still shuts down cleanly', async () => {
    const preloadDir = tempDirs.make('of-preload-');
    const preload = join(preloadDir, 'throwLater.mjs');
    writeFileSync(preload, "setTimeout(() => { setTimeout(() => { throw new Error('boom-after-boot'); }, 10); }, 4000);\n");
    const { daemon, port } = await bootOnFreePort({ OPENFLEET_HOME: homeWith() }, preload);
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
