import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_UNATTENDED_SILENT_BLOCK_SECONDS, loadPermissionSettings } from './permissionSettings.js';

let configPath: string;
const writeConfig = (contents: object | string) => writeFileSync(configPath, typeof contents === 'string' ? contents : JSON.stringify(contents));

beforeEach(() => {
  configPath = join(mkdtempSync(join(tmpdir(), 'of-permission-unattended-')), 'config.json');
});

describe('loadPermissionSettings: seconds before a prompt nobody sees is called a silent block', () => {
  it('waits 30 seconds by default, whether the file or the key is missing', () => {
    const withoutFile = loadPermissionSettings(configPath).unattendedSilentBlockSeconds;
    writeConfig({ permissions: { silentBlockMinutes: 7 } });
    const withoutKey = loadPermissionSettings(configPath).unattendedSilentBlockSeconds;

    expect([withoutFile, withoutKey, DEFAULT_UNATTENDED_SILENT_BLOCK_SECONDS]).toEqual([30, 30, 30]);
  });

  it.each([1, 45, 3600])('reads %i seconds without touching the minutes', (unattendedSilentBlockSeconds) => {
    writeConfig({ permissions: { silentBlockMinutes: 7, unattendedSilentBlockSeconds } });

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 7, unattendedSilentBlockSeconds });
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['above an hour', 3601],
    ['fractional', 2.5],
    ['a string', '30'],
    ['null', null],
  ])('falls back to 30 seconds for %s and keeps the minutes', (_label, unattendedSilentBlockSeconds) => {
    writeConfig({ permissions: { silentBlockMinutes: 7, unattendedSilentBlockSeconds } });

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 5, unattendedSilentBlockSeconds: 30 });
  });

  it('falls back to 30 seconds for a config that is not JSON', () => {
    writeConfig('{ nope');

    expect(loadPermissionSettings(configPath).unattendedSilentBlockSeconds).toBe(30);
  });
});
