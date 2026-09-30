import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDaemonSettings } from './workingStateSettings.js';

const configWithPatterns = (handoverPatterns: unknown): string => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'of-ws-patterns-')), 'config.json');
  writeFileSync(configPath, JSON.stringify({ workingState: { handoverPatterns }, models: { opus: 'opus' } }));
  return configPath;
};

describe('the operator sets the handover patterns in config.json', () => {
  it('leaves the patterns unset when the key is absent so the defaults apply', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'of-ws-patterns-')), 'config.json');
    writeFileSync(configPath, '{"workingState":{"enforce":true}}');

    expect(loadDaemonSettings(configPath).workingState.handoverPatterns).toBeUndefined();
  });

  it('boots with valid patterns, compiled once into global regular expressions, and with an empty list', () => {
    const settings = loadDaemonSettings(configWithPatterns(['TICKET-\\d+', 'https://figma\\.com/file/[^\\s]+'])).workingState;

    expect(settings.handoverPatterns).toEqual([/TICKET-\d+/gu, /https:\/\/figma\.com\/file\/[^\s]+/gu]);
    expect(loadDaemonSettings(configWithPatterns([])).workingState.handoverPatterns).toEqual([]);
  });

  it('refuses to boot on a pattern that is not a valid regular expression, naming the pattern', () => {
    expect(() => loadDaemonSettings(configWithPatterns(['ok\\d', '(unclosed']))).toThrow(/handoverPatterns.*\(unclosed/);
  });

  it.each(['(a+)+$', '(.*)*x', '([a-z]+)*z', '(\\d{2,})+'])('refuses to boot on the catastrophic backtracking pattern %s', (unsafePattern) => {
    expect(() => loadDaemonSettings(configWithPatterns([unsafePattern]))).toThrow(/handoverPatterns.*backtracking/);
  });

  it.each(['((x+))+y', '((?:x|x))+y', '(?:(x+))*y'])('refuses to boot on the nested-group catastrophic pattern %s', (unsafePattern) => {
    expect(() => loadDaemonSettings(configWithPatterns([unsafePattern]))).toThrow(/handoverPatterns.*backtracking/);
  });

  it('accepts a quantified group without a quantifier inside it, and an optional group', () => {
    expect(() => loadDaemonSettings(configWithPatterns(['(?:ab)+', '(https://x/)?[a-z]+']))).not.toThrow();
  });

  it('refuses to boot on a pattern that matches the empty string', () => {
    expect(() => loadDaemonSettings(configWithPatterns(['a*']))).toThrow(/handoverPatterns.*empty/);
  });

  it.each([
    ['a pattern over 200 characters', ['a'.repeat(201)]],
    ['more than 10 patterns', Array.from({ length: 11 }, (_, index) => `p${index}`)],
    ['an empty pattern', ['']],
    ['a non-string pattern', [42]],
    ['a string instead of a list', 'TICKET-\\d+'],
    ['null', null],
  ])('refuses to boot on %s', (_label, invalid) => {
    expect(() => loadDaemonSettings(configWithPatterns(invalid))).toThrow(/workingState/);
  });

  it('accepts a pattern of exactly 200 characters and exactly 10 patterns', () => {
    expect(() => loadDaemonSettings(configWithPatterns(['a'.repeat(200)]))).not.toThrow();
    expect(() => loadDaemonSettings(configWithPatterns(Array.from({ length: 10 }, (_, index) => `p${index}`)))).not.toThrow();
  });
});
