import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';

const PowerSchema = z.object({ preventIdleSleepWhileGenerating: z.boolean().optional() }).strict();
const ConfigSchema = z.object({ power: PowerSchema.optional() });

export interface PowerSettings {
  preventIdleSleepWhileGenerating: boolean;
}

export function loadPowerSettings(configPath: string, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): PowerSettings {
  const defaults = { preventIdleSleepWhileGenerating: platform === 'darwin' };
  if (!existsSync(configPath)) return defaults;
  try {
    const rawConfig: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const config = ConfigSchema.parse(rawConfig);
    return { preventIdleSleepWhileGenerating: config.power?.preventIdleSleepWhileGenerating ?? defaults.preventIdleSleepWhileGenerating };
  } catch (error) {
    throw new Error(`invalid power config at ${configPath}: ${readableConfigReason(error)}`);
  }
}
