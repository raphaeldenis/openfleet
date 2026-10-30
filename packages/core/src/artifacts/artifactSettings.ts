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

const ArtifactsObjectSchema = z.record(z.string(), z.unknown());

const FIELD_SCHEMAS: Record<keyof ArtifactSettings, z.ZodType<number>> = {
  maxFileBytes: z.number().int().min(1).max(MAX_ALLOWED_FILE_BYTES),
  maxProjectBytes: z.number().int().min(1).max(MAX_ALLOWED_PROJECT_BYTES),
};

/**
 * Reads the `artifacts` key of config.json: the per-file maximum and the per-project quota, in bytes. Each field is
 * validated on its own: an invalid field takes its default with a warning and the other field keeps its valid value.
 * An unreadable file or an `artifacts` value that is not an object falls back to both defaults with a warning.
 */
export function loadArtifactSettings(configPath: string): ArtifactSettings {
  if (!existsSync(configPath)) return DEFAULT_ARTIFACT_SETTINGS;
  try {
    const rawArtifacts = JSON.parse(readFileSync(configPath, 'utf8'))?.artifacts;
    if (rawArtifacts === undefined) return DEFAULT_ARTIFACT_SETTINGS;
    const artifactsObject = ArtifactsObjectSchema.safeParse(rawArtifacts);
    if (artifactsObject.success) return settingsFrom(artifactsObject.data, configPath);
    log('warn', `artifacts config at ${configPath} is ignored, the defaults apply: ${readableConfigReason(artifactsObject.error)}`);
  } catch (error) {
    log('warn', `artifacts config at ${configPath} is ignored, the defaults apply: ${readableConfigReason(error)}`);
  }
  return DEFAULT_ARTIFACT_SETTINGS;
}

function validFieldOrDefault(field: keyof ArtifactSettings, rawValue: unknown, configPath: string): number {
  if (rawValue === undefined) return DEFAULT_ARTIFACT_SETTINGS[field];
  const parsed = FIELD_SCHEMAS[field].safeParse(rawValue);
  if (parsed.success) return parsed.data;
  log('warn', `artifacts.${field} at ${configPath} is ignored, the default applies: ${readableConfigReason(parsed.error)}`);
  return DEFAULT_ARTIFACT_SETTINGS[field];
}

function settingsFrom(rawArtifacts: Record<string, unknown>, configPath: string): ArtifactSettings {
  const maxFileBytes = validFieldOrDefault('maxFileBytes', rawArtifacts.maxFileBytes, configPath);
  const maxProjectBytes = validFieldOrDefault('maxProjectBytes', rawArtifacts.maxProjectBytes, configPath);
  const isFileLargerThanQuota = maxFileBytes > maxProjectBytes;
  return isFileLargerThanQuota ? { maxFileBytes: maxProjectBytes, maxProjectBytes } : { maxFileBytes, maxProjectBytes };
}
