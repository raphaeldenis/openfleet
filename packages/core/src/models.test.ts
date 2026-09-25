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

  it('throws instead of booting the daemon on malformed JSON in the config file, naming the path', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, '{ not json');
    expect(() => loadModelTable(configPath)).toThrow(configPath);
  });

  it('strips a rung name unknown to ModelTable rather than letting it spill into the loaded table', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { gpt: 'gpt-4' } }));
    const table = loadModelTable(configPath) as unknown as Record<string, string>;
    expect(table.gpt).toBeUndefined();
  });

  it('throws when a rung value in the config file is not a string', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { sonnet: 123 } }));
    expect(() => loadModelTable(configPath)).toThrow(configPath);
  });
});

describe('resolveModel', () => {
  it('resolves a rung name from the table', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'sonnet')).toBe(DEFAULT_MODEL_TABLE.sonnet);
  });

  it('passes an exact model id through unchanged', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'claude-sonnet-5-20260101')).toBe('claude-sonnet-5-20260101');
  });

  it('passes an unrecognized rung name through unchanged', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'gpt-4')).toBe('gpt-4');
  });

  it('passes "constructor" through unchanged rather than returning the inherited Object.prototype member', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'constructor')).toBe('constructor');
  });

  it('resolves a mixed-case rung name from the table', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'Opus')).toBe(DEFAULT_MODEL_TABLE.opus);
  });

  it('resolves an all-caps rung name from the table', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'FABLE')).toBe(DEFAULT_MODEL_TABLE.fable);
  });

  it('passes "Constructor" through unchanged rather than matching the inherited Object.prototype member', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'Constructor')).toBe('Constructor');
  });

  it('passes an exact model id with mixed case through unchanged rather than lower-casing it', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'Claude-Sonnet-5-Custom')).toBe('Claude-Sonnet-5-Custom');
  });

  it('does not trim a whitespace-padded rung name, so it passes through unchanged instead of resolving', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, ' opus ')).toBe(' opus ');
  });

  it('resolves a mixed-case rung name against a config override rather than the default table', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { opus: 'claude-opus-5-5-custom' } }));
    const table = loadModelTable(configPath);
    expect(resolveModel(table, 'Opus')).toBe('claude-opus-5-5-custom');
  });
});
