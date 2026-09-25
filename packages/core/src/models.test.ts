import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_TABLE, loadModelTable, resolveModel } from './models.js';

describe('loadModelTable', () => {
  it('falls back to the default table when no config file exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    expect(loadModelTable(join(home, 'config.json'))).toEqual(DEFAULT_MODEL_TABLE);
  });

  it('overrides only the rungs present in the config file', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { sonnet: 'claude-sonnet-5-custom' } }));
    const table = loadModelTable(configPath);
    expect(table.sonnet).toBe('claude-sonnet-5-custom');
    expect(table.haiku).toBe(DEFAULT_MODEL_TABLE.haiku);
  });

  it('throws instead of booting the daemon on malformed JSON in the config file', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, '{ not json');
    expect(() => loadModelTable(configPath)).toThrow();
  });

  it('lets a rung name unknown to ModelTable spill into the loaded table unvalidated', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { gpt: 'gpt-4' } }));
    const table = loadModelTable(configPath) as unknown as Record<string, string>;
    expect(table.gpt).toBe('gpt-4');
  });

  it('lets a non-string rung value violate the string contract of ModelTable unvalidated', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { sonnet: 123 } }));
    const table = loadModelTable(configPath) as unknown as Record<string, unknown>;
    expect(table.sonnet).toBe(123);
  });
});

describe('resolveModel', () => {
  it('resolves a rung name from the table', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'sonnet')).toBe(DEFAULT_MODEL_TABLE.sonnet);
  });

  it('passes an exact model id through unchanged', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'claude-sonnet-5-20260101')).toBe('claude-sonnet-5-20260101');
  });

  it('passes an empty string through unchanged rather than resolving it to a rung', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, '')).toBe('');
  });

  it('is case-sensitive: a differently-cased rung name passes through unchanged', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'Sonnet')).toBe('Sonnet');
  });

  it('passes an unrecognized rung name through unchanged', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'gpt-4')).toBe('gpt-4');
  });

  it('returns an inherited Object.prototype member instead of the id for a rung named after one', () => {
    const result = resolveModel(DEFAULT_MODEL_TABLE, 'constructor');
    expect(typeof result).toBe('function');
    expect(result).not.toBe('constructor');
  });
});
