import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDaemonSettings } from './workingState/workingStateSettings.js';
import { refuseBootOnFailure } from './bootFailure.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function bootWithConfigJson(configJson: string) {
  const home = mkdtempSync(join(tmpdir(), 'of-boot-refusal-'));
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

  it('prints the message and the config path on one line and exits 1', async () => {
    const { written, exitCodes } = await runFailingBoot(new Error('admin token is too short'));

    expect(exitCodes).toEqual([1]);
    expect(written.join('')).toBe('openfleet: refusing to boot (config: /home/of/config.json): admin token is too short\n');
  });

  it('keeps only the first line of a multi-line reason and never prints a stack', async () => {
    const error = new Error('first line\nsecond line');

    const { written } = await runFailingBoot(error);

    expect(written.join('')).not.toContain('second line');
    expect(written.join('')).not.toContain(' at ');
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
    const home = mkdtempSync(join(tmpdir(), 'of-settings-reason-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ workingState: { maxAgeMinutes: 0 } }));

    const message = (() => { try { loadDaemonSettings(configPath); } catch (error) { return (error as Error).message; } return ''; })();

    expect(message).toContain('workingState.maxAgeMinutes');
    expect(message).not.toContain('"origin"');
    expect(message).not.toContain('\n');
  });
});
