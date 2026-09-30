import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadDaemonSettings } from './workingStateSettings.js';

const configWith = (contents: string | undefined): string => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'of-cn-config-')), 'config.json');
  if (contents !== undefined) writeFileSync(configPath, contents);
  return configPath;
};
const loadContextNotice = (contextNotice: unknown) => loadDaemonSettings(configWith(JSON.stringify({ contextNotice }))).contextNotice;

describe('the operator sets the context notice in config.json', () => {
  it('watches managers from 300,000 tokens then every 100,000 by default, without a config file, without the key and with an empty contextNotice', () => {
    const expected = { firstAt: 300_000, every: 100_000, roles: { manager: true }, models: {} };

    expect(loadDaemonSettings(configWith(undefined)).contextNotice).toEqual(expected);
    expect(loadDaemonSettings(configWith('{}')).contextNotice).toEqual(expected);
    expect(loadContextNotice({})).toEqual(expected);
  });

  it('reads firstAt and every within 1,000 to 10,000,000 so live QA can lower the first threshold to a size a short session reaches', () => {
    expect(loadContextNotice({ firstAt: 1_000, every: 1_000 })).toMatchObject({ firstAt: 1_000, every: 1_000 });
    expect(loadContextNotice({ firstAt: 20_000, every: 5_000 })).toMatchObject({ firstAt: 20_000, every: 5_000 });
    expect(loadContextNotice({ firstAt: 10_000_000, every: 10_000_000 })).toMatchObject({ firstAt: 10_000_000, every: 10_000_000 });
  });

  it.each([999, 10_000_001, 300_000.5, '300000', null, 0, -1])('refuses to boot on a firstAt of %s and names contextNotice.firstAt', (invalid) => {
    expect(() => loadContextNotice({ firstAt: invalid })).toThrow(/contextNotice\.firstAt: /);
  });

  it.each([999, 10_000_001, 100_000.5, '100000', null, 0, -1])('refuses to boot on an every of %s and names contextNotice.every', (invalid) => {
    expect(() => loadContextNotice({ every: invalid })).toThrow(/contextNotice\.every: /);
  });

  it('enables the notice per role, keeping the manager default when roles is absent and replacing it when roles is given', () => {
    expect(loadContextNotice({ roles: { manager: false, child: true, plain: true } }).roles).toEqual({ manager: false, child: true, plain: true });
    expect(loadContextNotice({ roles: { plain: true } }).roles).toEqual({ plain: true });
  });

  it.each([
    [{ managers: true }, /contextNotice\.roles: .*managers/],
    [{ manager: 'yes' }, /contextNotice\.roles\.manager: /],
    [{ child: 1 }, /contextNotice\.roles\.child: /],
  ])('refuses to boot on roles %j and names the wrong key', (roles, expectedMessage) => {
    expect(() => loadContextNotice({ roles })).toThrow(expectedMessage);
  });

  it('overrides firstAt and every per model alias, field by field', () => {
    const settings = loadContextNotice({ models: { haiku: { firstAt: 120_000, every: 40_000 }, sonnet: { every: 50_000 } } });

    expect(settings.models).toEqual({ haiku: { firstAt: 120_000, every: 40_000 }, sonnet: { every: 50_000 } });
  });

  it.each([
    ['a model override below the range', { models: { haiku: { firstAt: 999 } } }, /contextNotice\.models\.haiku\.firstAt: /],
    ['an unknown key in a model override', { models: { haiku: { firstAtt: 120_000 } } }, /contextNotice\.models\.haiku: .*firstAtt/],
    ['an empty model alias', { models: { '': { firstAt: 120_000 } } }, /contextNotice\.models\.?: /],
    ['an unknown key next to firstAt', { firstAt: 300_000, evry: 1 }, /contextNotice: .*evry/],
  ])('refuses to boot on %s and names the wrong key', (_label, contextNotice, expectedMessage) => {
    expect(() => loadContextNotice(contextNotice)).toThrow(expectedMessage);
  });

  it.each([
    ['a misspelled contextNotice', '{"contextNotices":{"firstAt":20000}}', /unknown key "contextNotices", the key is "contextNotice"/],
    ['a contextNotice with another case', '{"contextnotice":{"firstAt":20000}}', /unknown key "contextnotice", the key is "contextNotice"/],
  ])('refuses to boot on %s instead of running on the default thresholds', (_label, contents, expectedMessage) => {
    expect(() => loadDaemonSettings(configWith(contents))).toThrow(expectedMessage);
  });

  it('warns once at boot, as advice, about a models key that is not in the known model list, and keeps the override', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const settings = loadContextNotice({ models: { hiku: { firstAt: 120_000 }, haiku: { firstAt: 120_000 } } });

    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]?.[0]).toMatch(/contextNotice\.models\.hiku is not in the known model list/);
    expect(warnings.mock.calls[0]?.[0]).not.toMatch(/no session follows it/);
    expect(settings.models).toHaveProperty('hiku');
    warnings.mockRestore();
  });

  it('warns about nothing when every models alias is a known model', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadContextNotice({ models: { haiku: { firstAt: 120_000 }, 'claude-opus-5-5': { every: 50_000 }, 'claude-sonnet-5-5': { firstAt: 150_000 } } });

    expect(warnings).not.toHaveBeenCalled();
    warnings.mockRestore();
  });
});
