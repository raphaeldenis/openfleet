import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';

export interface PermissionSettings {
  silentBlockMinutes: number;
  /** How long a child nobody watches may wait on a prompt before the daemon raises the alert. */
  unattendedSilentBlockSeconds: number;
}

export const DEFAULT_SILENT_BLOCK_MINUTES = 5;
export const DEFAULT_UNATTENDED_SILENT_BLOCK_SECONDS = 30;
const MIN_SILENT_BLOCK_MINUTES = 1;
const MAX_SILENT_BLOCK_MINUTES = 1440;
const MIN_UNATTENDED_SILENT_BLOCK_SECONDS = 1;
const MAX_UNATTENDED_SILENT_BLOCK_SECONDS = 3600;

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  silentBlockMinutes: DEFAULT_SILENT_BLOCK_MINUTES,
  unattendedSilentBlockSeconds: DEFAULT_UNATTENDED_SILENT_BLOCK_SECONDS,
};

const PermissionsSchema = z.object({
  silentBlockMinutes: z.number().int().min(MIN_SILENT_BLOCK_MINUTES).max(MAX_SILENT_BLOCK_MINUTES).optional(),
  unattendedSilentBlockSeconds: z.number().int().min(MIN_UNATTENDED_SILENT_BLOCK_SECONDS).max(MAX_UNATTENDED_SILENT_BLOCK_SECONDS).optional(),
});

/**
 * Reads the `permissions` key of config.json. The settings only tune a notice, so an unreadable file or a
 * malformed value falls back to the defaults with a warning instead of refusing the boot.
 */
export function loadPermissionSettings(configPath: string): PermissionSettings {
  if (!existsSync(configPath)) return DEFAULT_PERMISSION_SETTINGS;
  try {
    const rawPermissions = JSON.parse(readFileSync(configPath, 'utf8'))?.permissions;
    if (rawPermissions === undefined) return DEFAULT_PERMISSION_SETTINGS;
    const parsed = PermissionsSchema.safeParse(rawPermissions);
    if (parsed.success) {
      return {
        silentBlockMinutes: parsed.data.silentBlockMinutes ?? DEFAULT_SILENT_BLOCK_MINUTES,
        unattendedSilentBlockSeconds: parsed.data.unattendedSilentBlockSeconds ?? DEFAULT_UNATTENDED_SILENT_BLOCK_SECONDS,
      };
    }
    log('warn', `permissions config at ${configPath} is ignored, the default applies: ${readableConfigReason(parsed.error)}`);
  } catch (error) {
    log('warn', `permissions config at ${configPath} is ignored, the default applies: ${readableConfigReason(error)}`);
  }
  return DEFAULT_PERMISSION_SETTINGS;
}
