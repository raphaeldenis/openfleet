import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';

export interface HandoffSettings { writeOnClose: boolean }

export const DEFAULT_HANDOFF_SETTINGS: HandoffSettings = { writeOnClose: true };

const WriteOnCloseSchema = z.object({ writeOnClose: z.boolean() });

/**
 * Reads the `handoff` key of config.json. The setting only chooses a default, so an unreadable file or a
 * malformed value falls back to the default with a warning instead of refusing the boot.
 */
export function loadHandoffSettings(configPath: string): HandoffSettings {
  if (!existsSync(configPath)) return DEFAULT_HANDOFF_SETTINGS;
  try {
    const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    const rawHandoff = rawConfig?.handoff;
    if (rawHandoff === undefined) return DEFAULT_HANDOFF_SETTINGS;
    const parsed = WriteOnCloseSchema.safeParse(rawHandoff);
    if (parsed.success) return { writeOnClose: parsed.data.writeOnClose };
    log('warn', `handoff config at ${configPath} is ignored, the default applies: ${readableConfigReason(parsed.error)}`);
  } catch (error) {
    log('warn', `handoff config at ${configPath} is ignored, the default applies: ${readableConfigReason(error)}`);
  }
  return DEFAULT_HANDOFF_SETTINGS;
}
