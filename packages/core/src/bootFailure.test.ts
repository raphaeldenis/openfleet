import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModelTable } from './models.js';
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

  it.each([
    ['a string', 'disk on fire', 'disk on fire'],
    ['undefined', undefined, 'unknown error'],
    ['null', null, 'unknown error'],
    ['an object', { code: 7 }, 'unknown error'],
  ])('prints a sensible reason when the boot throws %s', async (_name, thrown, expectedReason) => {
    const { written } = await runFailingBoot(thrown);

    expect(written.join('')).toBe(`openfleet: refusing to boot (config: /home/of/config.json): ${expectedReason}\n`);
  });

  it('caps the reason at 200 characters', async () => {
    const { written } = await runFailingBoot(new Error('x'.repeat(500)));

    const reason = written.join('').split('): ')[1]!.trimEnd();
    expect(reason).toHaveLength(200);
  });

  it('strips control characters so a reason cannot rewrite the terminal', async () => {
    const { written } = await runFailingBoot(new Error('bad\u001b[31m\u0007 value\r'));

    expect(written.join('')).toBe('openfleet: refusing to boot (config: /home/of/config.json): bad[31m value\n');
  });

  it('never shows a snippet of a broken config.json, only its path and the position', async () => {
    const home = mkdtempSync(join(tmpdir(), 'of-boot-secret-'));
    writeFileSync(join(home, 'config.json'), '{ "adminToken": FAKESECRET-123 }');
    const bootError = (() => { try { loadModelTable(join(home, 'config.json')); } catch (error) { return error; } })();

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
    const home = mkdtempSync(join(tmpdir(), 'of-settings-reason-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ workingState: { maxAgeMinutes: 0 } }));

    const message = (() => { try { loadDaemonSettings(configPath); } catch (error) { return (error as Error).message; } return ''; })();

    expect(message).toContain('workingState.maxAgeMinutes');
    expect(message).not.toContain('"origin"');
    expect(message).not.toContain('\n');
  });
});
