import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_SETTINGS, loadPermissionSettings } from './permissionSettings.js';

let configPath: string;
const writeConfig = (contents: string) => writeFileSync(configPath, contents);

beforeEach(() => {
  configPath = join(mkdtempSync(join(tmpdir(), 'of-permission-settings-')), 'config.json');
});

describe('loadPermissionSettings', () => {
  it('waits 5 minutes by default when the config file does not exist', () => {
    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 5 });
    expect(DEFAULT_PERMISSION_SETTINGS).toEqual({ silentBlockMinutes: 5 });
  });

  it('waits 5 minutes by default when the config has no permissions key', () => {
    writeConfig(JSON.stringify({ handoff: { writeOnClose: false } }));

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 5 });
  });

  it.each([1, 10, 1440])('reads %i minutes', (silentBlockMinutes) => {
    writeConfig(JSON.stringify({ permissions: { silentBlockMinutes } }));

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes });
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['above a day', 1441],
    ['fractional', 2.5],
    ['a string', '5'],
    ['null', null],
  ])('falls back to the default for %s without throwing', (_label, silentBlockMinutes) => {
    writeConfig(JSON.stringify({ permissions: { silentBlockMinutes } }));

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 5 });
  });

  it('falls back to the default for a permissions section that is not an object', () => {
    writeConfig(JSON.stringify({ permissions: 'off' }));

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 5 });
  });

  it('falls back to the default for a config file that is not JSON, without throwing', () => {
    writeConfig('{ not json');

    expect(loadPermissionSettings(configPath)).toEqual({ silentBlockMinutes: 5 });
  });
});
