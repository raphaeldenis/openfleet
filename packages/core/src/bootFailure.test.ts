import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadModelTable } from './models.js';
import { loadDaemonSettings } from './workingState/workingStateSettings.js';
import { refuseBootOnFailure } from './bootFailure.js';
import { createTempDirTracker } from './tempDirTracker.js';
import { ConfigFileError, readingConfigFile } from './configFileError.js';
import { PortInUseError } from './errors/portInUseError.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function bootWithConfigJson(configJson: string) {
  const home = tempDirs.make('of-boot-refusal-');
  writeFileSync(join(home, 'config.json'), configJson);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: CORE_ROOT, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, OPENFLEET_HOME: home, OPENFLEET_PORT: '0' },
  });
  return { ...result, configPath: join(home, 'config.json') };
}

describe('operator sees a boot refused for an invalid config.json as a fatal error', () => {
  it.each([
    ['workingState.maxAgeMinutes 0', { workingState: { maxAgeMinutes: 0 } }],
    ['managers.heartbeatDefaultSeconds 0', { managers: { heartbeatDefaultSeconds: 0 } }],
  ])('exits non-zero with one readable stderr line for %s', (_name, config) => {
    const boot = bootWithConfigJson(JSON.stringify(config));

    const stderrLines = boot.stderr.trim().split('\n');
    expect(boot.status).toBe(1);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain(boot.configPath);
    expect(stderrLines[0]).not.toMatch(/uncaughtException|daemon continuing|\n\s+at /);
    expect(stderrLines[0]).not.toContain('"code"');
  });
});

describe('refuseBootOnFailure', () => {
  const runFailingBoot = async (error: unknown) => {
    const written: string[] = [];
    const exitCodes: number[] = [];
    await refuseBootOnFailure(async () => { throw error; }, { configPath: '/home/of/config.json', writeStderr: (text) => written.push(text), exit: (code) => { exitCodes.push(code); throw new Error('process exited'); } }).catch(() => undefined);
    return { written, exitCodes };
  };

  it('prints the config path and the reason on one line and exits 1 when the config file is the cause', async () => {
    const { written, exitCodes } = await runFailingBoot(new ConfigFileError(new Error('workingState.maxAgeMinutes: too small')));

    expect(exitCodes).toEqual([1]);
    expect(written.join('')).toBe('openfleet: refusing to boot (config: /home/of/config.json): workingState.maxAgeMinutes: too small\n');
  });

  it('names only the reason, never the config path, when the cause is not the config file', async () => {
    const { written } = await runFailingBoot(new Error('admin token is too short'));

    expect(written.join('')).toBe('openfleet: refusing to boot: admin token is too short\n');
  });

  it('tells how to recover when the port is in use', async () => {
    const { written } = await runFailingBoot(new PortInUseError(7331));

    expect(written.join('')).toBe('openfleet: refusing to boot: port 7331 is already in use (stop the other process or set OPENFLEET_PORT)\n');
  });

  it('tells how to recover when OPENFLEET_PORT is not a valid port', async () => {
    const badPort = Object.assign(new RangeError('options.port should be >= 0 and < 65536. Received type number (NaN).'), { code: 'ERR_SOCKET_BAD_PORT' });

    const { written } = await runFailingBoot(badPort);

    expect(written.join('')).toContain('(set OPENFLEET_PORT to a port between 0 and 65535)');
  });

  it.each(['EACCES', 'EPERM', 'EROFS'])('names the unreadable path and asks to check its permissions on %s', async (code) => {
    const denied = Object.assign(new Error(`${code}: denied, rmdir '/home/of/sessions/x'`), { code, path: '/home/of/sessions/x' });

    const { written } = await runFailingBoot(denied);

    expect(written.join('')).toBe(`openfleet: refusing to boot: ${code}: denied, rmdir '/home/of/sessions/x' (check the permissions of /home/of/sessions/x)\n`);
  });

  it('gives no hint for a permission error that carries no path', async () => {
    const { written } = await runFailingBoot(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }));

    expect(written.join('')).toBe('openfleet: refusing to boot: listen EACCES\n');
  });

  it('keeps only the first line of a multi-line reason and never prints a stack', async () => {
    const error = new Error('first line\nsecond line');

    const { written } = await runFailingBoot(error);

    expect(written.join('')).not.toContain('second line');
    expect(written.join('')).not.toContain(' at ');
  });

  it.each([
    ['a string', 'disk on fire', 'disk on fire'],
    ['undefined', undefined, 'unknown error'],
    ['null', null, 'unknown error'],
    ['an object', { code: 7 }, 'unknown error'],
  ])('prints a sensible reason when the boot throws %s', async (_name, thrown, expectedReason) => {
    const { written } = await runFailingBoot(thrown);

    expect(written.join('')).toBe(`openfleet: refusing to boot: ${expectedReason}\n`);
  });

  it('caps the reason at 200 characters and still appends the recovery hint', async () => {
    const { written } = await runFailingBoot(Object.assign(new Error('x'.repeat(500)), { code: 'EACCES', path: '/h/p' }));

    expect(written.join('')).toBe(`openfleet: refusing to boot: ${'x'.repeat(200)} (check the permissions of /h/p)\n`);
  });

  it('strips control characters so a reason cannot rewrite the terminal', async () => {
    const { written } = await runFailingBoot(new Error('bad\u001b[31m\u0007 value\r'));

    expect(written.join('')).toBe('openfleet: refusing to boot: bad[31m value\n');
  });

  it('never shows a snippet of a broken config.json, only its path and the position', async () => {
    const home = tempDirs.make('of-boot-secret-');
    writeFileSync(join(home, 'config.json'), '{ "adminToken": FAKESECRET-123 }');
    const bootError = (() => { try { readingConfigFile(() => loadModelTable(join(home, 'config.json'))); } catch (error) { return error; } })();

    const { written } = await runFailingBoot(bootError);

    expect(written.join('')).not.toContain('FAKESECRET');
    expect(written.join('')).toContain('/home/of/config.json');
    expect(written.join('')).toMatch(/not valid JSON/);
  });

  it('returns the booted value untouched when the boot succeeds', async () => {
    const exitCodes: number[] = [];

    const booted = await refuseBootOnFailure(async () => 'daemon', { configPath: 'x', writeStderr: () => undefined, exit: (code) => { exitCodes.push(code); throw new Error('process exited'); } });

    expect(booted).toBe('daemon');
    expect(exitCodes).toEqual([]);
  });
});

describe('loadDaemonSettings reason', () => {
  it('names the offending key without a raw zod JSON dump', () => {
    const home = tempDirs.make('of-settings-reason-');
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ workingState: { maxAgeMinutes: 0 } }));

    const message = (() => { try { loadDaemonSettings(configPath); } catch (error) { return (error as Error).message; } return ''; })();

    expect(message).toContain('workingState.maxAgeMinutes');
    expect(message).not.toContain('"origin"');
    expect(message).not.toContain('\n');
  });
});
