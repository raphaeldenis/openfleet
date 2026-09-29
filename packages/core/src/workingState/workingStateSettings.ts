import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const DEFAULT_WORKING_STATE_MAX_BYTES = 6144;
const MIN_WORKING_STATE_MAX_BYTES = 1024;
const MAX_WORKING_STATE_MAX_BYTES = 8192;

export const DEFAULT_WORKING_STATE_MAX_AGE_MINUTES = 30;
const MIN_MAX_AGE_MINUTES = 1;
const MAX_MAX_AGE_MINUTES = 1440;

export interface WorkingStateSettings { maxBytes: number; enforce: boolean; maxAgeMinutes: number }

const DEFAULT_SETTINGS: WorkingStateSettings = { maxBytes: DEFAULT_WORKING_STATE_MAX_BYTES, enforce: true, maxAgeMinutes: DEFAULT_WORKING_STATE_MAX_AGE_MINUTES };

const ConfigFileSchema = z.object({
  workingState: z.object({
    maxBytes: z.number().int().min(MIN_WORKING_STATE_MAX_BYTES).max(MAX_WORKING_STATE_MAX_BYTES).optional(),
    enforce: z.boolean().optional(),
    maxAgeMinutes: z.number().int().min(MIN_MAX_AGE_MINUTES).max(MAX_MAX_AGE_MINUTES).optional(),
  }).strict().optional(),
});

const definedOnly = <T extends object>(values: T): Partial<T> => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;

const isMisspelledWorkingStateKey = (key: string) => key !== 'workingState' && key.toLowerCase() === 'workingstate';

// A malformed cap fails the boot loudly, like the model table: a typo must not run every session on a cap nobody chose.
export function loadWorkingStateSettings(configPath: string): WorkingStateSettings {
  if (!existsSync(configPath)) return DEFAULT_SETTINGS;
  try {
    const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    const parsed = ConfigFileSchema.parse(rawConfig);
    const misspelledKey = Object.keys(rawConfig).find(isMisspelledWorkingStateKey);
    if (misspelledKey) throw new Error(`unknown key "${misspelledKey}", the key is "workingState"`);
    return { ...DEFAULT_SETTINGS, ...definedOnly(parsed.workingState ?? {}) };
  } catch (error) {
    throw new Error(`invalid workingState config at ${configPath}: ${(error as Error).message}`);
  }
}
