import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';
import type { ArtifactSettings } from './artifactDirectory.js';

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
/** The hook body is read up to 1 MiB and JSON escaping grows the content, so a bigger Write never reaches the judge. */
const MAX_ALLOWED_FILE_BYTES = 512 * KIBIBYTE;
const MAX_ALLOWED_PROJECT_BYTES = 1024 * MEBIBYTE;

export const DEFAULT_ARTIFACT_SETTINGS: ArtifactSettings = { maxFileBytes: 256 * KIBIBYTE, maxProjectBytes: 50 * MEBIBYTE };

const ArtifactsSchema = z.object({
  maxFileBytes: z.number().int().min(1).max(MAX_ALLOWED_FILE_BYTES).optional(),
  maxProjectBytes: z.number().int().min(1).max(MAX_ALLOWED_PROJECT_BYTES).optional(),
}).strict();

/**
 * Reads the `artifacts` key of config.json: the per-file maximum and the per-project quota, in bytes. An unreadable
 * file or a malformed value falls back to the defaults with a warning, so a typo never widens the limits.
 */
export function loadArtifactSettings(configPath: string): ArtifactSettings {
  if (!existsSync(configPath)) return DEFAULT_ARTIFACT_SETTINGS;
  try {
    const rawArtifacts = JSON.parse(readFileSync(configPath, 'utf8'))?.artifacts;
    if (rawArtifacts === undefined) return DEFAULT_ARTIFACT_SETTINGS;
    const parsed = ArtifactsSchema.safeParse(rawArtifacts);
    if (parsed.success) return settingsFrom(parsed.data);
    log('warn', `artifacts config at ${configPath} is ignored, the defaults apply: ${readableConfigReason(parsed.error)}`);
  } catch (error) {
    log('warn', `artifacts config at ${configPath} is ignored, the defaults apply: ${readableConfigReason(error)}`);
  }
  return DEFAULT_ARTIFACT_SETTINGS;
}

function settingsFrom(parsed: z.infer<typeof ArtifactsSchema>): ArtifactSettings {
  const maxFileBytes = parsed.maxFileBytes ?? DEFAULT_ARTIFACT_SETTINGS.maxFileBytes;
  const maxProjectBytes = parsed.maxProjectBytes ?? DEFAULT_ARTIFACT_SETTINGS.maxProjectBytes;
  const isFileLargerThanQuota = maxFileBytes > maxProjectBytes;
  return isFileLargerThanQuota ? { maxFileBytes: maxProjectBytes, maxProjectBytes } : { maxFileBytes, maxProjectBytes };
}
