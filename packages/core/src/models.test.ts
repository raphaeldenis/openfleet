import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelIdSchema } from '@openfleet/shared';
import { DEFAULT_MODEL_TABLE, listAvailableModels, loadModelTable, resolveModel } from './models.js';
import { recentLogLines } from './logger.js';

const RUNG_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'];

describe('default model table', () => {
  it('maps every rung to its alias so a session always runs the latest iteration', () => {
    expect(DEFAULT_MODEL_TABLE).toEqual({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' });
  });

  it('holds no dated or versioned model id', () => {
    const versionedId = /\d/;
    for (const modelId of Object.values(DEFAULT_MODEL_TABLE)) expect(modelId).not.toMatch(versionedId);
  });

  it('resolves each rung name to its alias in the default table', () => {
    expect(RUNG_ALIASES.map((rung) => resolveModel(DEFAULT_MODEL_TABLE, rung))).toEqual(RUNG_ALIASES);
  });

  it('resolves a rung to the model the table maps it to, not to the rung name itself', () => {
    const customTable = { ...DEFAULT_MODEL_TABLE, opus: 'my-opus' };
    expect(resolveModel(customTable, 'opus')).toBe('my-opus');
  });

  it('passes a 1M-context id through resolution and validation unchanged', () => {
    const longContextId = 'claude-opus-5-5[1m]';
    expect(resolveModel(DEFAULT_MODEL_TABLE, longContextId)).toBe(longContextId);
    expect(ModelIdSchema.parse(longContextId)).toBe(longContextId);
  });

  it('accepts every alias as a model id', () => {
    expect(RUNG_ALIASES.map((alias) => ModelIdSchema.parse(alias))).toEqual(RUNG_ALIASES);
  });
});

describe('model id charset', () => {
  const acceptedIds = ['a', 'A9', 'claude-opus-5-5', 'gpt-6-astra', 'a.b:c', 'a[b]', 'claude-opus-5-5[1m]', 'a-', 'a_b'];
  const refusedIds = ['', '-a', '[a', 'a b', 'a\nb', 'a\r\nb', 'a\tb', 'a\u0000b', 'é', 'aé', 'a/b', 'a'.repeat(101)];

  it.each(acceptedIds)('accepts %j', (id) => {
    expect(ModelIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(refusedIds)('refuses %j', (id) => {
    expect(ModelIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('available models', () => {
  it('offers Haiku 5.5 and excludes the retired Haiku 4.5 ids', async () => {
    const available = await listAvailableModels();

    expect(available).toContain('claude-haiku-5-5');
    expect(available).not.toContain('claude-haiku-4-5');
    expect(available).not.toContain('claude-haiku-4-5-20251001');
    expect(new Set(available).size).toBe(available.length);
  });

  it('lists the four aliases first', async () => {
    const available = await listAvailableModels();

    expect(available.slice(0, RUNG_ALIASES.length)).toEqual(RUNG_ALIASES);
  });

  it('lists the 1M-context aliases of opus and sonnet right after the four aliases, and none for haiku', async () => {
    const available = await listAvailableModels();

    const afterAliases = available.slice(RUNG_ALIASES.length, RUNG_ALIASES.length + 2);
    expect(afterAliases).toEqual(['opus[1m]', 'sonnet[1m]']);
    expect(available).not.toContain('haiku[1m]');
  });

  it('lists only schema-valid model ids', async () => {
    const available = await listAvailableModels();

    const rejectedIds = available.filter((modelId) => !ModelIdSchema.safeParse(modelId).success);
    expect(rejectedIds).toEqual([]);
  });
});

describe('loadModelTable', () => {
  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'synthetic-unknown-model'])('warns visibly before a stored unavailable model %s reaches launch resolution', (modelId) => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { haiku: modelId } }));
    const previousLogCount = recentLogLines().length;

    const table = loadModelTable(configPath);

    expect(resolveModel(table, 'haiku')).toBe(modelId);
    const newLogs = recentLogLines().slice(previousLogCount).map((line) => JSON.parse(line));
    expect(newLogs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'stored model is not in the known model list; check availability and update the model settings before launching',
      rung: 'haiku',
      modelId,
    }));
  });

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

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('throws when a rung in the config file is %s instead of serving a blank model id', (_label, blankRung) => {
    const home = mkdtempSync(join(tmpdir(), 'of-models-'));
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ models: { sonnet: blankRung } }));
    expect(() => loadModelTable(configPath)).toThrow(configPath);
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

  it('passes an exact model id with mixed case through unchanged rather than lower-casing it', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, 'Claude-Sonnet-5-Custom')).toBe('Claude-Sonnet-5-Custom');
  });

  it('does not trim a whitespace-padded rung name, so it passes through unchanged instead of resolving', () => {
    expect(resolveModel(DEFAULT_MODEL_TABLE, ' opus ')).toBe(' opus ');
  });
});
