import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_HANDOFF_SETTINGS, loadHandoffSettings } from './handoffSettings.js';

let configPath: string;
const writeConfig = (contents: string) => writeFileSync(configPath, contents);

beforeEach(() => {
  configPath = join(mkdtempSync(join(tmpdir(), 'of-handoff-settings-')), 'config.json');
});

describe('loadHandoffSettings', () => {
  it('writes on close by default when the config file does not exist', () => {
    const settings = loadHandoffSettings(configPath);

    expect(settings).toEqual({ writeOnClose: true });
    expect(DEFAULT_HANDOFF_SETTINGS).toEqual({ writeOnClose: true });
  });

  it('writes on close by default when the config has no handoff key', () => {
    writeConfig(JSON.stringify({ managers: { heartbeatDefaultSeconds: 60 } }));

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: true });
  });

  it('reads writeOnClose false', () => {
    writeConfig(JSON.stringify({ handoff: { writeOnClose: false } }));

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: false });
  });

  it('reads writeOnClose true', () => {
    writeConfig(JSON.stringify({ handoff: { writeOnClose: true } }));

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: true });
  });

  it.each([
    ['a string', { writeOnClose: 'no' }],
    ['a number', { writeOnClose: 0 }],
    ['null', { writeOnClose: null }],
    ['a handoff that is not an object', 'off'],
  ])('falls back to the default for %s without throwing', (_label, handoff) => {
    writeConfig(JSON.stringify({ handoff }));

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: true });
  });

  it('ignores an unknown key next to a valid writeOnClose', () => {
    writeConfig(JSON.stringify({ handoff: { writeOnClose: false, extra: 1 } }));

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: false });
  });

  it('falls back to the default for a config file that is not JSON, without throwing', () => {
    writeConfig('{ not json');

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: true });
  });

  it('is not disturbed by another section being invalid', () => {
    writeConfig(JSON.stringify({ workingState: { maxBytes: 1 }, handoff: { writeOnClose: false } }));

    expect(loadHandoffSettings(configPath)).toEqual({ writeOnClose: false });
  });
});
