import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export interface ModelTable { haiku: string; sonnet: string; opus: string; fable: string }

export const DEFAULT_MODEL_TABLE: ModelTable = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

// ponytail: a hand-kept list — it goes stale when a model ships and needs a release to catch up.
// Upgrade path: query the Anthropic /v1/models API inside listAvailableModels() when an API key is present.
const KNOWN_MODELS: readonly string[] = [
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
];

/** Returns the model ids a rung can be set to; the only place the list's source is decided. */
export async function listAvailableModels(): Promise<string[]> {
  return [...KNOWN_MODELS];
}

const MAX_MODEL_ID_LENGTH = 100;
const MODEL_ID_CHARACTERS = /^[A-Za-z0-9._:[\]-]+$/;

const ModelId = z.string().trim().min(1);
const ModelIdToSave = ModelId.max(MAX_MODEL_ID_LENGTH).regex(MODEL_ID_CHARACTERS);

export const ModelTablePatchSchema = z
  .strictObject({ haiku: ModelIdToSave.optional(), sonnet: ModelIdToSave.optional(), opus: ModelIdToSave.optional(), fable: ModelIdToSave.optional() })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one rung is required' });

export type ModelTablePatch = z.infer<typeof ModelTablePatchSchema>;

export class ModelConfigUnreadableError extends Error {}

const ModelConfigFileSchema = z.object({
  models: z.object({ haiku: ModelId, sonnet: ModelId, opus: ModelId, fable: ModelId }).partial().optional(),
});

export function loadModelTable(configPath: string): ModelTable {
  if (!existsSync(configPath)) return { ...DEFAULT_MODEL_TABLE };
  // A malformed model table must fail the boot loudly, not silently fall back — a typo here should not
  // launch every future session on the wrong model.
  try {
    const parsed = ModelConfigFileSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
    return { ...DEFAULT_MODEL_TABLE, ...parsed.models };
  } catch (error) {
    throw new Error(`invalid model table config at ${configPath}: ${(error as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfigFileForUpdate(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const unreadable = (reason: string) => new ModelConfigUnreadableError(`config at ${configPath} ${reason}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw unreadable('is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw unreadable('is not a JSON object');
  const hasModelsThatAreNotAnObject = parsed.models !== undefined && !isPlainObject(parsed.models);
  if (hasModelsThatAreNotAnObject) throw unreadable('has a "models" entry that is not an object');
  return parsed;
}

/** Merges the patch into the config file's models, keeping every other key, and swaps the file in atomically. */
export function saveModelPatch(configPath: string, patch: ModelTablePatch): void {
  const existingConfig = readConfigFileForUpdate(configPath);
  const nextConfig = { ...existingConfig, models: { ...(existingConfig.models as object | undefined), ...patch } };
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    renameSync(temporaryPath, configPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

// A caller passes either a rung name (looked up here, case-insensitively) or an exact model id, passed
// through unchanged with its original casing. Object.hasOwn (not `in`) so a rung named after an inherited
// Object.prototype member (e.g. "constructor") passes through as a plain string instead of returning that
// inherited function.
export function resolveModel(table: ModelTable, rungOrId: string): string {
  const rung = rungOrId.toLowerCase();
  return Object.hasOwn(table, rung) ? table[rung as keyof ModelTable] : rungOrId;
}
