import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const DEFAULT_WORKING_STATE_MAX_BYTES = 6144;
const MIN_WORKING_STATE_MAX_BYTES = 1024;
const MAX_WORKING_STATE_MAX_BYTES = 8192;

export interface WorkingStateSettings { maxBytes: number }

const ConfigFileSchema = z.object({
  workingState: z.object({
    maxBytes: z.number().int().min(MIN_WORKING_STATE_MAX_BYTES).max(MAX_WORKING_STATE_MAX_BYTES).optional(),
  }).optional(),
});

// A malformed cap fails the boot loudly, like the model table: a typo must not run every session on a cap nobody chose.
export function loadWorkingStateSettings(configPath: string): WorkingStateSettings {
  if (!existsSync(configPath)) return { maxBytes: DEFAULT_WORKING_STATE_MAX_BYTES };
  try {
    const parsed = ConfigFileSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
    return { maxBytes: parsed.workingState?.maxBytes ?? DEFAULT_WORKING_STATE_MAX_BYTES };
  } catch (error) {
    throw new Error(`invalid workingState config at ${configPath}: ${(error as Error).message}`);
  }
}
