import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPowerSettings } from './powerSettings.js';

const scratch = fileURLToPath(new URL('../../../../.scratch/', import.meta.url));
const configWith = (power: unknown): string => {
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, 'power-settings-')), 'config.json');
  writeFileSync(path, JSON.stringify({ power, models: { opus: 'opus' } }));
  return path;
};

describe('power settings at daemon boot', () => {
  it('defaults to enabled on macOS, disabled elsewhere, and honors a boot-time opt out', () => {
    expect(loadPowerSettings(configWith(undefined), { platform: 'darwin' }).preventIdleSleepWhileGenerating).toBe(true);
    expect(loadPowerSettings(configWith(undefined), { platform: 'linux' }).preventIdleSleepWhileGenerating).toBe(false);
    expect(loadPowerSettings(configWith({ preventIdleSleepWhileGenerating: false }), { platform: 'darwin' }).preventIdleSleepWhileGenerating).toBe(false);
  });

  it.each([{ preventIdleSleepWhileGenerating: 'false' }, { preventIdleSleepWhileGenerating: null }, { preventIdleSleepWhileGeneratin: true }])('refuses an invalid power setting %j', (power) => {
    expect(() => loadPowerSettings(configWith(power))).toThrow(/power/);
  });
});
