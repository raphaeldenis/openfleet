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

  it.each([
    ['a misspelled maxBytes', '{"workingState":{"maxByte":2048}}'],
    ['a misspelled workingState', '{"workingstate":{"maxBytes":2048}}'],
    ['an unknown key next to maxBytes', '{"workingState":{"maxBytes":2048,"maxBytez":1}}'],
  ])('refuses to boot on %s instead of running on the default cap', (_label, contents) => {
    expect(() => loadWorkingStateSettings(configWith(contents))).toThrow(/workingState/);
  });

  it('operator can enable enforcement and set the state age limit, defaulting to enforced at 30 minutes', () => {
    expect(loadWorkingStateSettings(configWith(undefined))).toMatchObject({ enforce: true, maxAgeMinutes: 30 });
    expect(loadWorkingStateSettings(configWith('{"workingState":{"enforce":false,"maxAgeMinutes":5}}'))).toMatchObject({ enforce: false, maxAgeMinutes: 5 });
    expect(loadWorkingStateSettings(configWith('{"workingState":{"maxAgeMinutes":1}}')).maxAgeMinutes).toBe(1);
    expect(loadWorkingStateSettings(configWith('{"workingState":{"maxAgeMinutes":1440}}')).maxAgeMinutes).toBe(1440);
  });

  it.each([0, 1441, 2.5, '30', null])('refuses to boot on a maxAgeMinutes of %s instead of clamping it', (invalid) => {
    expect(() => loadWorkingStateSettings(configWith(JSON.stringify({ workingState: { maxAgeMinutes: invalid } })))).toThrow(/workingState/);
  });

  it.each(['false', 0, null])('refuses to boot on an enforce of %s', (invalid) => {
    expect(() => loadWorkingStateSettings(configWith(JSON.stringify({ workingState: { enforce: invalid } })))).toThrow(/workingState/);
  });

  it('leaves the other keys of config.json, like the models table, alone', () => {
    expect(loadWorkingStateSettings(configWith('{"models":{"opus":"opus"},"somethingElse":true}')).maxBytes).toBe(6144);
  });

  it.each([['an empty file', ''], ['a truncated file', '{'], ['a BOM-prefixed file', '﻿{"workingState":{"maxBytes":2048}}']])('refuses to boot on %s', (_label, contents) => {
    expect(() => loadWorkingStateSettings(configWith(contents))).toThrow(/workingState/);
  });
});
