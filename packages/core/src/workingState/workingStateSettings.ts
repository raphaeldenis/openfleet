import { existsSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';

export const DEFAULT_WORKING_STATE_MAX_BYTES = 6144;
const MIN_WORKING_STATE_MAX_BYTES = 1024;
const MAX_WORKING_STATE_MAX_BYTES = 8192;

export const DEFAULT_WORKING_STATE_MAX_AGE_MINUTES = 30;
const MIN_MAX_AGE_MINUTES = 1;
const MAX_MAX_AGE_MINUTES = 1440;

const MAX_HANDOVER_PATTERNS = 10;
const MAX_HANDOVER_PATTERN_LENGTH = 200;
const UNBOUNDED_QUANTIFIER = String.raw`(?:[+*]|\{\d+,\})\??`;
const SINGLE_ATOM = String.raw`(?:\\[pP]\{[^}]*\}|\\.|\[(?:\\.|[^\]\\])*\]|[^\\()|\[\]+*?{}])`;
// ponytail: static heuristics on the source text, not a parser. Groups nested inside groups escape them; the boot self-test below is the net.
const BACKTRACKING_RISKS = [
  { reason: 'a quantifier inside a quantified group', pattern: /\((?:\\.|[^()\\])*(?:[+*]|\{\d+,\d*\})(?:\\.|[^()\\])*\)(?:[+*]|\{\d+,?\d*\})/ },
  { reason: 'an alternation inside a group repeated without an upper bound', pattern: /\((?:\\.|[^()\\])*\|(?:\\.|[^()\\])*\)(?:[+*]|\{\d+,\})/ },
  { reason: 'two unbounded quantifiers on adjacent atoms', pattern: new RegExp(`${SINGLE_ATOM}${UNBOUNDED_QUANTIFIER}${SINGLE_ATOM}${UNBOUNDED_QUANTIFIER}`) },
];
const SELF_TEST_TEXT_LENGTH = 2000;
const SELF_TEST_BUDGET_MS = 50;
const SELF_TEST_ADVERSARIAL_TEXTS = [`${'a'.repeat(SELF_TEST_TEXT_LENGTH)}b`, 'ab'.repeat(SELF_TEST_TEXT_LENGTH / 2), 'a'.repeat(SELF_TEST_TEXT_LENGTH), 'x'.repeat(SELF_TEST_TEXT_LENGTH)];
const HANDOVER_PATTERN_FLAGS = 'gu';

export const DEFAULT_HEARTBEAT_SECONDS = 1800;
const MIN_HEARTBEAT_SECONDS = 1;
const MAX_HEARTBEAT_SECONDS = 86_400;

/** `handoverPatterns` is unset when the operator keeps the built-in patterns. */
export interface WorkingStateSettings { maxBytes: number; enforce: boolean; maxAgeMinutes: number; handoverPatterns?: RegExp[] }
export interface ManagerSettings { heartbeatDefaultSeconds: number }
export interface DaemonSettings { workingState: WorkingStateSettings; managers: ManagerSettings }

const DEFAULT_WORKING_STATE_SETTINGS: WorkingStateSettings = { maxBytes: DEFAULT_WORKING_STATE_MAX_BYTES, enforce: true, maxAgeMinutes: DEFAULT_WORKING_STATE_MAX_AGE_MINUTES };
const DEFAULT_MANAGER_SETTINGS: ManagerSettings = { heartbeatDefaultSeconds: DEFAULT_HEARTBEAT_SECONDS };

const ConfigFileSchema = z.object({
  workingState: z.object({
    maxBytes: z.number().int().min(MIN_WORKING_STATE_MAX_BYTES).max(MAX_WORKING_STATE_MAX_BYTES).optional(),
    enforce: z.boolean().optional(),
    maxAgeMinutes: z.number().int().min(MIN_MAX_AGE_MINUTES).max(MAX_MAX_AGE_MINUTES).optional(),
    handoverPatterns: z.array(z.string().max(MAX_HANDOVER_PATTERN_LENGTH)).max(MAX_HANDOVER_PATTERNS).optional(),
  }).strict().optional(),
  managers: z.object({
    heartbeatDefaultSeconds: z.number().int().min(MIN_HEARTBEAT_SECONDS).max(MAX_HEARTBEAT_SECONDS).optional(),
  }).strict().optional(),
});

// The vm timeout interrupts a runaway regex, so a catastrophic pattern refuses the boot instead of freezing it.
function scansAdversarialTextsWithinBudget(source: string): boolean {
  const scan = new Script('text.match(new RegExp(source, flags))');
  try {
    for (const text of SELF_TEST_ADVERSARIAL_TEXTS) scan.runInNewContext({ text, source, flags: HANDOVER_PATTERN_FLAGS }, { timeout: SELF_TEST_BUDGET_MS });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return false;
    throw error;
  }
}

function compileHandoverPattern(source: string, position: number): RegExp {
  const label = `handoverPatterns[${position}] "${source}"`;
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, HANDOVER_PATTERN_FLAGS);
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${(error as Error).message}`);
  }
  const backtrackingRisk = BACKTRACKING_RISKS.find(({ pattern }) => pattern.test(source));
  if (backtrackingRisk) throw new Error(`${label} risks catastrophic backtracking (${backtrackingRisk.reason})`);
  if (new RegExp(source, 'u').test('')) throw new Error(`${label} matches the empty string`);
  if (!scansAdversarialTextsWithinBudget(source)) throw new Error(`${label} takes more than ${SELF_TEST_BUDGET_MS} ms to scan a ${SELF_TEST_TEXT_LENGTH}-character adversarial text (catastrophic backtracking)`);
  return compiled;
}

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
    const { handoverPatterns, ...scalarSettings } = parsed.workingState ?? {};
    const compiledPatterns = handoverPatterns?.map(compileHandoverPattern);
    return {
      workingState: { ...DEFAULT_WORKING_STATE_SETTINGS, ...definedOnly(scalarSettings), ...(compiledPatterns && { handoverPatterns: compiledPatterns }) },
      managers: { ...DEFAULT_MANAGER_SETTINGS, ...definedOnly(parsed.managers ?? {}) },
    };
  } catch (error) {
    throw new Error(`invalid workingState/managers config at ${configPath}: ${readableConfigReason(error)}`);
  }
}
