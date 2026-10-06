import { existsSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { z } from 'zod';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';
import { KNOWN_MODELS } from '../models.js';

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

export const DEFAULT_CONTEXT_NOTICE_FIRST_AT = 300_000;
export const DEFAULT_CONTEXT_NOTICE_EVERY = 100_000;
const MIN_CONTEXT_NOTICE_TOKENS = 1000;
const MAX_CONTEXT_NOTICE_TOKENS = 10_000_000;

export const CONTEXT_NOTICE_ROLES = ['manager', 'child', 'plain'] as const;
export type ContextNoticeRole = (typeof CONTEXT_NOTICE_ROLES)[number];
export interface ContextNoticeThresholds { firstAt: number; every: number }

/** A role absent from `roles` is not watched, and a given `roles` replaces the default `{ manager: true }` entirely. A model alias absent from `models` follows `firstAt` and `every`. */
export interface ContextNoticeSettings extends ContextNoticeThresholds {
  roles: Partial<Record<ContextNoticeRole, boolean>>;
  models: Record<string, Partial<ContextNoticeThresholds>>;
}

/** `handoverPatterns` is unset when the operator keeps the built-in patterns. */
export interface WorkingStateSettings { maxBytes: number; enforce: boolean; maxAgeMinutes: number; handoverPatterns?: RegExp[] }
export interface ManagerSettings { heartbeatDefaultSeconds: number }
export interface DaemonSettings { workingState: WorkingStateSettings; managers: ManagerSettings; contextNotice: ContextNoticeSettings }

const DEFAULT_WORKING_STATE_SETTINGS: WorkingStateSettings = { maxBytes: DEFAULT_WORKING_STATE_MAX_BYTES, enforce: true, maxAgeMinutes: DEFAULT_WORKING_STATE_MAX_AGE_MINUTES };
const DEFAULT_MANAGER_SETTINGS: ManagerSettings = { heartbeatDefaultSeconds: DEFAULT_HEARTBEAT_SECONDS };
const DEFAULT_CONTEXT_NOTICE_SETTINGS: ContextNoticeSettings = { firstAt: DEFAULT_CONTEXT_NOTICE_FIRST_AT, every: DEFAULT_CONTEXT_NOTICE_EVERY, roles: { manager: true }, models: {} };

const ContextNoticeTokensSchema = z.number().int().min(MIN_CONTEXT_NOTICE_TOKENS).max(MAX_CONTEXT_NOTICE_TOKENS);
const ContextNoticeThresholdsSchema = z.object({ firstAt: ContextNoticeTokensSchema.optional(), every: ContextNoticeTokensSchema.optional() }).strict();

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
  contextNotice: ContextNoticeThresholdsSchema.extend({
    roles: z.object({ manager: z.boolean().optional(), child: z.boolean().optional(), plain: z.boolean().optional() }).strict().optional(),
    models: z.record(z.string().min(1), ContextNoticeThresholdsSchema).optional(),
  }).strict().optional(),
});

// The vm timeout interrupts a runaway regex, so a catastrophic pattern refuses the boot instead of freezing it.
function scansAdversarialTextsWithinBudget(source: string, handoverPatternBudgetMs: number): boolean {
  const scan = new Script('text.match(new RegExp(source, flags))');
  try {
    for (const text of SELF_TEST_ADVERSARIAL_TEXTS) scan.runInNewContext({ text, source, flags: HANDOVER_PATTERN_FLAGS }, { timeout: handoverPatternBudgetMs });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return false;
    throw error;
  }
}

function compileHandoverPattern(source: string, position: number, handoverPatternBudgetMs: number): RegExp {
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
  const scansWithinBudget = scansAdversarialTextsWithinBudget(source, handoverPatternBudgetMs);
  if (!scansWithinBudget) throw new Error(`${label} takes more than ${handoverPatternBudgetMs} ms to scan a ${SELF_TEST_TEXT_LENGTH}-character adversarial text (catastrophic backtracking)`);
  return compiled;
}

const definedOnly = <T extends object>(values: T): Partial<T> => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;

const SECTION_KEYS = ['workingState', 'managers', 'contextNotice'];
const spelledLoosely = (key: string) => key.toLowerCase().replace(/s$/, '');
const misspelledSectionKey = (key: string) => SECTION_KEYS.find((section) => key !== section && spelledLoosely(key) === spelledLoosely(section));

function warnAboutUnknownModelAliases(models: ContextNoticeSettings['models']): void {
  const unknownAliases = Object.keys(models).filter((alias) => !KNOWN_MODELS.includes(alias));
  for (const alias of unknownAliases) log('warn', `contextNotice.models.${alias} is not in the known model list, check its spelling (the override is applied to any session on that model)`);
}

// A malformed value fails the boot loudly, like the model table: a typo must not run every session on a setting nobody chose.
export function loadDaemonSettings(configPath: string, { handoverPatternBudgetMs = SELF_TEST_BUDGET_MS }: { handoverPatternBudgetMs?: number } = {}): DaemonSettings {
  const defaults: DaemonSettings = { workingState: DEFAULT_WORKING_STATE_SETTINGS, managers: DEFAULT_MANAGER_SETTINGS, contextNotice: DEFAULT_CONTEXT_NOTICE_SETTINGS };
  if (!existsSync(configPath)) return defaults;
  try {
    const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    const parsed = ConfigFileSchema.parse(rawConfig);
    const misspelledKey = Object.keys(rawConfig).find(misspelledSectionKey);
    if (misspelledKey) throw new Error(`unknown key "${misspelledKey}", the key is "${misspelledSectionKey(misspelledKey)}"`);
    warnAboutUnknownModelAliases(parsed.contextNotice?.models ?? {});
    const { handoverPatterns, ...scalarSettings } = parsed.workingState ?? {};
    const compiledPatterns = handoverPatterns?.map((source, position) => compileHandoverPattern(source, position, handoverPatternBudgetMs));
    return {
      workingState: { ...DEFAULT_WORKING_STATE_SETTINGS, ...definedOnly(scalarSettings), ...(compiledPatterns && { handoverPatterns: compiledPatterns }) },
      managers: { ...DEFAULT_MANAGER_SETTINGS, ...definedOnly(parsed.managers ?? {}) },
      contextNotice: { ...DEFAULT_CONTEXT_NOTICE_SETTINGS, ...definedOnly(parsed.contextNotice ?? {}) },
    };
  } catch (error) {
    throw new Error(`invalid workingState/managers/contextNotice config at ${configPath}: ${readableConfigReason(error)}`);
  }
}
