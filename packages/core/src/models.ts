import { existsSync, readFileSync } from 'node:fs';

export interface ModelTable { haiku: string; sonnet: string; opus: string; fable: string }

export const DEFAULT_MODEL_TABLE: ModelTable = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

interface ModelConfigFile { models?: Partial<ModelTable> }

export function loadModelTable(configPath: string): ModelTable {
  if (!existsSync(configPath)) return DEFAULT_MODEL_TABLE;
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as ModelConfigFile;
  return { ...DEFAULT_MODEL_TABLE, ...parsed.models };
}

// A caller passes either a rung name (looked up here) or an exact model id, passed through unchanged.
export function resolveModel(table: ModelTable, rungOrId: string): string {
  return rungOrId in table ? table[rungOrId as keyof ModelTable] : rungOrId;
}
