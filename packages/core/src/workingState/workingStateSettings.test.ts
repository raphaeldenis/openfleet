import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDaemonSettings } from './workingStateSettings.js';

const loadWorkingStateSettings = (configPath: string) => loadDaemonSettings(configPath).workingState;
const loadManagerSettings = (configPath: string) => loadDaemonSettings(configPath).managers;

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

describe('the operator sets the default heartbeat of a manager in config.json', () => {
  const configWithHeartbeat = (heartbeatDefaultSeconds: unknown) => configWith(JSON.stringify({ managers: { heartbeatDefaultSeconds }, models: { opus: 'opus' } }));

  it('defaults to 1800 seconds without a config file, without the key, and with an empty managers', () => {
    expect(loadManagerSettings(configWith(undefined)).heartbeatDefaultSeconds).toBe(1800);
    expect(loadManagerSettings(configWith('{}')).heartbeatDefaultSeconds).toBe(1800);
    expect(loadManagerSettings(configWith('{"managers":{}}')).heartbeatDefaultSeconds).toBe(1800);
  });

  it('reads managers.heartbeatDefaultSeconds within 1 to 86400', () => {
    expect(loadManagerSettings(configWithHeartbeat(600)).heartbeatDefaultSeconds).toBe(600);
    expect(loadManagerSettings(configWithHeartbeat(1)).heartbeatDefaultSeconds).toBe(1);
    expect(loadManagerSettings(configWithHeartbeat(86_400)).heartbeatDefaultSeconds).toBe(86_400);
  });

  it.each([0, 86_401, 1800.5, '1800', null])('refuses to boot on a heartbeatDefaultSeconds of %s', (invalid) => {
    expect(() => loadManagerSettings(configWithHeartbeat(invalid))).toThrow(/managers/);
  });

  it.each([
    ['a misspelled heartbeatDefaultSeconds', '{"managers":{"heartbeatDefaultSecond":600}}'],
    ['a misspelled managers', '{"manager":{"heartbeatDefaultSeconds":600}}'],
    ['an unknown key next to heartbeatDefaultSeconds', '{"managers":{"heartbeatDefaultSeconds":600,"pulse":1}}'],
  ])('refuses to boot on %s instead of running on the default heartbeat', (_label, contents) => {
    expect(() => loadManagerSettings(configWith(contents))).toThrow(/managers|manager/);
  });

  it('keeps the working state settings when only the heartbeat is set, and the heartbeat when only the working state is set', () => {
    const heartbeatOnly = loadDaemonSettings(configWithHeartbeat(600));
    const workingStateOnly = loadDaemonSettings(configWith('{"workingState":{"maxBytes":2048}}'));

    expect(heartbeatOnly.workingState.maxBytes).toBe(6144);
    expect(workingStateOnly.managers.heartbeatDefaultSeconds).toBe(1800);
  });
});
