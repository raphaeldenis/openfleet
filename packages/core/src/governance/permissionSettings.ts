import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';

export interface PermissionSettings { silentBlockMinutes: number }

export const DEFAULT_SILENT_BLOCK_MINUTES = 5;
const MIN_SILENT_BLOCK_MINUTES = 1;
const MAX_SILENT_BLOCK_MINUTES = 1440;

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = { silentBlockMinutes: DEFAULT_SILENT_BLOCK_MINUTES };

const PermissionsSchema = z.object({ silentBlockMinutes: z.number().int().min(MIN_SILENT_BLOCK_MINUTES).max(MAX_SILENT_BLOCK_MINUTES).optional() });

/**
 * Reads the `permissions` key of config.json. The setting only tunes a notice, so an unreadable file or a
 * malformed value falls back to the default with a warning instead of refusing the boot.
 */
export function loadPermissionSettings(configPath: string): PermissionSettings {
  if (!existsSync(configPath)) return DEFAULT_PERMISSION_SETTINGS;
  try {
    const rawPermissions = JSON.parse(readFileSync(configPath, 'utf8'))?.permissions;
    if (rawPermissions === undefined) return DEFAULT_PERMISSION_SETTINGS;
    const parsed = PermissionsSchema.safeParse(rawPermissions);
    if (parsed.success) return { silentBlockMinutes: parsed.data.silentBlockMinutes ?? DEFAULT_SILENT_BLOCK_MINUTES };
    log('warn', `permissions config at ${configPath} is ignored, the default applies: ${readableConfigReason(parsed.error)}`);
  } catch (error) {
    log('warn', `permissions config at ${configPath} is ignored, the default applies: ${readableConfigReason(error)}`);
  }
  return DEFAULT_PERMISSION_SETTINGS;
}
