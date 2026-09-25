import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export interface ModelTable { haiku: string; sonnet: string; opus: string; fable: string }

export const DEFAULT_MODEL_TABLE: ModelTable = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

const ModelConfigFileSchema = z.object({
  models: z.object({ haiku: z.string(), sonnet: z.string(), opus: z.string(), fable: z.string() }).partial().optional(),
});

export function loadModelTable(configPath: string): ModelTable {
  if (!existsSync(configPath)) return DEFAULT_MODEL_TABLE;
  // A malformed model table must fail the boot loudly, not silently fall back — a typo here should not
  // launch every future session on the wrong model.
  try {
    const parsed = ModelConfigFileSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
    return { ...DEFAULT_MODEL_TABLE, ...parsed.models };
  } catch (error) {
    throw new Error(`invalid model table config at ${configPath}: ${(error as Error).message}`);
  }
}

// A caller passes either a rung name (looked up here) or an exact model id, passed through unchanged.
// Object.hasOwn (not `in`) so a rung named after an inherited Object.prototype member (e.g. "constructor")
// passes through as a plain string instead of returning that inherited function.
export function resolveModel(table: ModelTable, rungOrId: string): string {
  return Object.hasOwn(table, rungOrId) ? table[rungOrId as keyof ModelTable] : rungOrId;
}
