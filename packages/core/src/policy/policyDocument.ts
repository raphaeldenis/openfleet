import {
  CommandPolicyOverrideSchema, DeclaredCommandsSchema, POLICY_DOCUMENT_VERSION, POLICY_MODES, PolicyProfileSchema, PolicyRuleSchema, UnattendedOverrideSchema,
  type CommandPolicyDocument, type CommandPolicyOverride, type PolicyMode, type PolicyProfile, type PolicyRule,
} from '@openfleet/shared';
import * as z from 'zod';
import { ALLOW_DECLARED_COMMANDS_RULE_ID } from './defaultCommandPolicy.js';

export type PolicyDocumentIssue =
  | { scope: 'document'; message: string }
  | { scope: 'field'; field: string; message: string }
  | { scope: 'rule'; index: number; ruleId?: string; message: string }
  | { scope: 'profile'; profile: string; message: string };

export type OverrideValidation = { ok: true; value: CommandPolicyOverride } | { ok: false; issues: string[] };

const ModeSchema = z.enum(POLICY_MODES);
const RuleIdListSchema = z.array(z.string().min(1));
const RoleMappingSchema = z.string().min(1);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describeIssue = (issue: z.core.$ZodIssue): string => `${issue.path.join('.') || 'document'}: ${issue.message}`;
const messageOf = (error: z.ZodError): string => error.issues.map(describeIssue).join('; ');

/** Strict validation for a document about to be saved: any invalid rule refuses the whole document. */
export function validateCommandPolicyOverride(raw: unknown): OverrideValidation {
  const parsed = CommandPolicyOverrideSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: parsed.error.issues.map(describeIssue) };
}

interface ParsedOverride {
  mode?: PolicyMode;
  declaredCommands: string[];
  disabledRules: string[];
  rules: PolicyRule[];
  profiles: Record<string, PolicyProfile>;
  roleToProfile: Record<string, string>;
  issues: PolicyDocumentIssue[];
}

function parseField<T>(raw: unknown, schema: z.ZodType<T>, field: string, issues: PolicyDocumentIssue[]): T | undefined {
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  issues.push({ scope: 'field', field, message: messageOf(parsed.error) });
  return undefined;
}

function parseRules(raw: unknown, issues: PolicyDocumentIssue[]): PolicyRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ scope: 'field', field: 'rules', message: 'rules must be a list' });
    return [];
  }
  return raw.flatMap((entry, index) => {
    const parsed = PolicyRuleSchema.safeParse(entry);
    if (parsed.success) return [parsed.data];
    const ruleId = isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : undefined;
    issues.push({ scope: 'rule', index, ...(ruleId === undefined ? {} : { ruleId }), message: messageOf(parsed.error) });
    return [];
  });
}

function parseProfiles(raw: unknown, issues: PolicyDocumentIssue[]): Record<string, PolicyProfile> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    issues.push({ scope: 'field', field: 'profiles', message: 'profiles must be an object' });
    return {};
  }
  const profiles: Record<string, PolicyProfile> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const parsed = PolicyProfileSchema.safeParse(entry);
    if (parsed.success) profiles[name] = parsed.data;
    else issues.push({ scope: 'profile', profile: name, message: messageOf(parsed.error) });
  }
  return profiles;
}

function parseRoleMappings(raw: unknown, issues: PolicyDocumentIssue[]): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    issues.push({ scope: 'field', field: 'roleToProfile', message: 'roleToProfile must be an object' });
    return {};
  }
  const mappings: Record<string, string> = {};
  for (const [role, profile] of Object.entries(raw)) {
    const parsed = RoleMappingSchema.safeParse(profile);
    if (parsed.success) mappings[role] = parsed.data;
    else issues.push({ scope: 'field', field: 'roleToProfile', message: `${role}: a profile name is required` });
  }
  return mappings;
}

const OVERRIDE_KEYS = new Set(['version', 'mode', 'unattended', 'declaredCommands', 'disabledRules', 'rules', 'profiles', 'roleToProfile']);

function parseOverride(override: Record<string, unknown>): ParsedOverride {
  const issues: PolicyDocumentIssue[] = [];
  for (const key of Object.keys(override).filter((candidate) => !OVERRIDE_KEYS.has(candidate))) {
    issues.push({ scope: 'field', field: key, message: 'unknown key' });
  }
  const mode = parseField(override.mode, ModeSchema, 'mode', issues);
  const declaredCommands = parseField(override.declaredCommands, DeclaredCommandsSchema, 'declaredCommands', issues) ?? [];
  const disabledRules = parseField(override.disabledRules, RuleIdListSchema, 'disabledRules', issues) ?? [];
  const rules = parseRules(override.rules, issues);
  const profiles = parseProfiles(override.profiles, issues);
  const roleToProfile = parseRoleMappings(override.roleToProfile, issues);
  return { ...(mode === undefined ? {} : { mode }), declaredCommands, disabledRules, rules, profiles, roleToProfile, issues };
}

function mergeRules(delivered: PolicyRule[], disabledIds: Set<string>, replacements: PolicyRule[]): PolicyRule[] {
  const replacementsById = new Map(replacements.map((rule) => [rule.id, rule]));
  const kept = delivered.filter((rule) => !disabledIds.has(rule.id)).map((rule) => replacementsById.get(rule.id) ?? rule);
  const keptIds = new Set(kept.map((rule) => rule.id));
  const added = [...replacementsById.values()].filter((rule) => !keptIds.has(rule.id));
  return [...kept, ...added];
}

function mergeRoleMappings(delivered: CommandPolicyDocument, parsed: ParsedOverride, profiles: Record<string, PolicyProfile>): Record<string, string> {
  const merged = { ...delivered.roleToProfile };
  for (const [role, profile] of Object.entries(parsed.roleToProfile)) {
    if (Object.hasOwn(profiles, profile)) merged[role] = profile;
    else parsed.issues.push({ scope: 'field', field: 'roleToProfile', message: `${role}: unknown profile ${profile}` });
  }
  return merged;
}

/** The override reduced to the parts that apply: what `resolveCommandPolicy` reports as an issue is left out, so the result always passes the strict validation. */
export function validPartsOfOverride({ delivered, override }: { delivered: CommandPolicyDocument; override: Record<string, unknown> }): CommandPolicyOverride {
  const isVersionSupported = override.version === POLICY_DOCUMENT_VERSION;
  if (!isVersionSupported) return { version: POLICY_DOCUMENT_VERSION };
  const parsed = parseOverride(override);
  const isStatedAndValid = (field: string): boolean =>
    override[field] !== undefined && !parsed.issues.some((issue) => issue.scope === 'field' && issue.field === field);
  const knownProfiles = { ...delivered.profiles, ...parsed.profiles };
  const roleToProfile = Object.fromEntries(Object.entries(parsed.roleToProfile).filter(([, profile]) => Object.hasOwn(knownProfiles, profile)));
  const unattended = UnattendedOverrideSchema.safeParse(override.unattended);
  return {
    version: POLICY_DOCUMENT_VERSION,
    ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
    ...(unattended.success && override.unattended !== undefined ? { unattended: unattended.data } : {}),
    ...(isStatedAndValid('declaredCommands') ? { declaredCommands: parsed.declaredCommands } : {}),
    ...(isStatedAndValid('disabledRules') ? { disabledRules: parsed.disabledRules } : {}),
    ...(isStatedAndValid('rules') ? { rules: parsed.rules } : {}),
    ...(isStatedAndValid('profiles') ? { profiles: parsed.profiles } : {}),
    ...(isStatedAndValid('roleToProfile') ? { roleToProfile } : {}),
  };
}

function withDeclaredCommands(rules: PolicyRule[], declaredCommands: string[]): PolicyRule[] {
  if (declaredCommands.length === 0) return rules;
  return rules.map((rule) => (rule.id === ALLOW_DECLARED_COMMANDS_RULE_ID ? { ...rule, when: { ...rule.when, runsDeclaredCommand: declaredCommands } } : rule));
}

/**
 * Merges the user's override into the delivered document. The override can disable a delivered rule by id, add or
 * replace rules, replace profiles and remap roles. Whatever is invalid is dropped and reported as an issue, and the
 * rest of the override still applies: a bad edit never leaves the session without the delivered rules.
 */
export function resolveCommandPolicy({ delivered, override }: { delivered: CommandPolicyDocument; override: unknown }): { policy: CommandPolicyDocument; issues: PolicyDocumentIssue[] } {
  if (override === undefined) return { policy: delivered, issues: [] };
  if (!isPlainObject(override)) return { policy: delivered, issues: [{ scope: 'document', message: 'the override must be a JSON object' }] };
  if (override.version !== POLICY_DOCUMENT_VERSION) {
    return { policy: delivered, issues: [{ scope: 'document', message: `unsupported override version ${String(override.version)}, expected ${POLICY_DOCUMENT_VERSION}` }] };
  }
  const parsed = parseOverride(override);
  const profiles = { ...delivered.profiles, ...parsed.profiles };
  const roleToProfile = mergeRoleMappings(delivered, parsed, profiles);
  const policy: CommandPolicyDocument = {
    version: delivered.version,
    mode: parsed.mode ?? delivered.mode,
    profiles,
    roleToProfile,
    rules: withDeclaredCommands(mergeRules(delivered.rules, new Set(parsed.disabledRules), parsed.rules), parsed.declaredCommands),
  };
  return { policy, issues: parsed.issues };
}
