import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkingStateSettings } from './workingStateSettings.js';

const configWith = (contents: string | undefined): string => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'of-ws-config-')), 'config.json');
  if (contents !== undefined) writeFileSync(configPath, contents);
  return configPath;
};
const configWithMaxBytes = (maxBytes: unknown) => configWith(JSON.stringify({ workingState: { maxBytes }, models: { opus: 'opus' } }));

describe('the operator sets the working state size cap in config.json', () => {
  it('defaults to 6144 bytes without a config file, without the key, and with an empty workingState', () => {
    expect(loadWorkingStateSettings(configWith(undefined)).maxBytes).toBe(6144);
    expect(loadWorkingStateSettings(configWith('{}')).maxBytes).toBe(6144);
    expect(loadWorkingStateSettings(configWith('{"workingState":{}}')).maxBytes).toBe(6144);
  });

  it('reads workingState.maxBytes within 1024 to 8192', () => {
    expect(loadWorkingStateSettings(configWithMaxBytes(2048)).maxBytes).toBe(2048);
    expect(loadWorkingStateSettings(configWithMaxBytes(1024)).maxBytes).toBe(1024);
    expect(loadWorkingStateSettings(configWithMaxBytes(8192)).maxBytes).toBe(8192);
  });

  it.each([1023, 8193, 6144.5, '6144', null])('refuses to boot on a maxBytes of %s', (invalid) => {
    expect(() => loadWorkingStateSettings(configWithMaxBytes(invalid))).toThrow(/workingState/);
  });
});
