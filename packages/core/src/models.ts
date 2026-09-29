import { ModelIdSchema } from '@openfleet/shared';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface ModelTable { haiku: string; sonnet: string; opus: string; fable: string }

export const DEFAULT_MODEL_TABLE: ModelTable = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'fable',
};

// ponytail: a hand-kept list curated from the claude CLI's /model picker (see P2-U6c) — it goes stale when a model ships and needs a release to catch up.
// Upgrade path: query the Anthropic /v1/models API inside listAvailableModels() when an API key is present.
const KNOWN_MODELS: readonly string[] = [
  'haiku',
  'sonnet',
  'opus',
  'fable',
  'opus[1m]',
  'sonnet[1m]',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5-5',
  'claude-opus-5-5[1m]',
  'claude-fable-5-1',
];

/** Returns the model ids a rung can be set to; the only place the list's source is decided. */
export async function listAvailableModels(): Promise<string[]> {
  return [...KNOWN_MODELS];
}

const ModelId = z.string().trim().min(1);

export const ModelTablePatchSchema = z
  .strictObject({ haiku: ModelIdSchema.optional(), sonnet: ModelIdSchema.optional(), opus: ModelIdSchema.optional(), fable: ModelIdSchema.optional() })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one rung is required' });

export type ModelTablePatch = z.infer<typeof ModelTablePatchSchema>;

export class ModelConfigUnreadableError extends Error {}
export class ModelConfigReadOnlyError extends Error {}

const NEW_CONFIG_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const OWNER_WRITE_BIT = 0o200;

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

/**
 * Merges the patch into the config file's models, keeping every other key, and swaps the file in atomically
 * once its bytes and its directory entry are on disk.
 * A symlinked config is written through to its target, the file keeps its permissions (a new one gets 0600),
 * and a read-only config is refused.
 */
export function saveModelPatch(configPath: string, patch: ModelTablePatch): void {
  const existingConfig = readConfigFileForUpdate(configPath);
  const nextConfig = { ...existingConfig, models: { ...(existingConfig.models as object | undefined), ...patch } };
  const configExists = existsSync(configPath);
  const targetPath = configExists ? realpathSync(configPath) : configPath;
  const existingMode = configExists ? statSync(targetPath).mode & PERMISSION_BITS : NEW_CONFIG_FILE_MODE;
  const isReadOnly = (existingMode & OWNER_WRITE_BIT) === 0;
  if (isReadOnly) throw new ModelConfigReadOnlyError(`config at ${configPath} is read-only`);

  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeNewFileDurably({ path: temporaryPath, contents: `${JSON.stringify(nextConfig, null, 2)}\n`, mode: existingMode });
    renameSync(temporaryPath, targetPath);
    flushDirectory(dirname(targetPath));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/** Creates the file exclusively (a planted symlink at that path makes it fail), then flushes it to disk. */
function writeNewFileDurably({ path, contents, mode }: { path: string; contents: string; mode: number }): void {
  const descriptor = openSync(path, 'wx', NEW_CONFIG_FILE_MODE);
  try {
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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
