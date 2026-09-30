import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';

export const DEFAULT_WORKING_STATE_MAX_BYTES = 6144;
const MIN_WORKING_STATE_MAX_BYTES = 1024;
const MAX_WORKING_STATE_MAX_BYTES = 8192;

export const DEFAULT_WORKING_STATE_MAX_AGE_MINUTES = 30;
const MIN_MAX_AGE_MINUTES = 1;
const MAX_MAX_AGE_MINUTES = 1440;

export const DEFAULT_HEARTBEAT_SECONDS = 1800;
const MIN_HEARTBEAT_SECONDS = 1;
const MAX_HEARTBEAT_SECONDS = 86_400;

export interface WorkingStateSettings { maxBytes: number; enforce: boolean; maxAgeMinutes: number }
export interface ManagerSettings { heartbeatDefaultSeconds: number }
export interface DaemonSettings { workingState: WorkingStateSettings; managers: ManagerSettings }

const DEFAULT_WORKING_STATE_SETTINGS: WorkingStateSettings = { maxBytes: DEFAULT_WORKING_STATE_MAX_BYTES, enforce: true, maxAgeMinutes: DEFAULT_WORKING_STATE_MAX_AGE_MINUTES };
const DEFAULT_MANAGER_SETTINGS: ManagerSettings = { heartbeatDefaultSeconds: DEFAULT_HEARTBEAT_SECONDS };

const ConfigFileSchema = z.object({
  workingState: z.object({
    maxBytes: z.number().int().min(MIN_WORKING_STATE_MAX_BYTES).max(MAX_WORKING_STATE_MAX_BYTES).optional(),
    enforce: z.boolean().optional(),
    maxAgeMinutes: z.number().int().min(MIN_MAX_AGE_MINUTES).max(MAX_MAX_AGE_MINUTES).optional(),
  }).strict().optional(),
  managers: z.object({
    heartbeatDefaultSeconds: z.number().int().min(MIN_HEARTBEAT_SECONDS).max(MAX_HEARTBEAT_SECONDS).optional(),
  }).strict().optional(),
});

const definedOnly = <T extends object>(values: T): Partial<T> => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;

const SECTION_KEYS = ['workingState', 'managers'];
const spelledLoosely = (key: string) => key.toLowerCase().replace(/s$/, '');
const misspelledSectionKey = (key: string) => SECTION_KEYS.find((section) => key !== section && spelledLoosely(key) === spelledLoosely(section));

// A malformed value fails the boot loudly, like the model table: a typo must not run every session on a setting nobody chose.
export function loadDaemonSettings(configPath: string): DaemonSettings {
  const defaults: DaemonSettings = { workingState: DEFAULT_WORKING_STATE_SETTINGS, managers: DEFAULT_MANAGER_SETTINGS };
  if (!existsSync(configPath)) return defaults;
  try {
    const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    const parsed = ConfigFileSchema.parse(rawConfig);
    const misspelledKey = Object.keys(rawConfig).find(misspelledSectionKey);
    if (misspelledKey) throw new Error(`unknown key "${misspelledKey}", the key is "${misspelledSectionKey(misspelledKey)}"`);
    return {
      workingState: { ...DEFAULT_WORKING_STATE_SETTINGS, ...definedOnly(parsed.workingState ?? {}) },
      managers: { ...DEFAULT_MANAGER_SETTINGS, ...definedOnly(parsed.managers ?? {}) },
    };
  } catch (error) {
    throw new Error(`invalid workingState/managers config at ${configPath}: ${readableConfigReason(error)}`);
  }
}
