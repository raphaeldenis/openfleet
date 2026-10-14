import * as z from 'zod';
import type { HarnessId } from './session.js';

export const MAX_RULE_TEXT_CHARS = 280;
const MAX_RULE_ID_CHARS = 80;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const POLICY_MODES = ['enforce', 'observe', 'off'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const PROFILE_MODES = ['enforce', 'observe'] as const;
export const RULE_DECISIONS = ['deny', 'allow', 'ask'] as const;
export const RULE_ACTORS = ['session', 'subagent', 'any'] as const;
export const RULE_PRESENCES = ['attended', 'unattended', 'any'] as const;
/** `someCommand` matches when one simple command satisfies the predicate; `everyCommand` needs a fully read line whose commands all do. */
export const RULE_COVERAGES = ['someCommand', 'everyCommand'] as const;

export interface FlagGroups { all?: string[][]; any?: string[][]; none?: string[][] }

/** Every key of a predicate must hold for a command; a key the schema does not know is refused rather than ignored. */
export interface RulePredicate {
  program?: string | string[];
  subcommand?: string | string[];
  flags?: FlagGroups;
  commandPrefix?: string[][];
  repoWideSearch?: boolean;
  writesPathMatching?: string[];
  argMatching?: string[];
  /** The command is a plain read of files under these roots (`{worktree}`, `{scratch}`, `{toolResults}` or absolute paths). */
  readsOnlyWithin?: string[];
  anyOf?: RulePredicate[];
  allOf?: RulePredicate[];
  not?: RulePredicate;
}

const NonEmptyText = z.string().min(1);
const OneOrMany = z.union([NonEmptyText, z.array(NonEmptyText).min(1)]);
const FlagAliasGroups = z.array(z.array(NonEmptyText).min(1));
const FlagGroupsSchema = z.strictObject({ all: FlagAliasGroups.optional(), any: FlagAliasGroups.optional(), none: FlagAliasGroups.optional() });

export const RulePredicateSchema: z.ZodType<RulePredicate> = z.lazy(() =>
  z.strictObject({
    program: OneOrMany.optional(),
    subcommand: OneOrMany.optional(),
    flags: FlagGroupsSchema.optional(),
    commandPrefix: z.array(z.array(NonEmptyText).min(1)).optional(),
    repoWideSearch: z.boolean().optional(),
    writesPathMatching: z.array(NonEmptyText).optional(),
    argMatching: z.array(NonEmptyText).optional(),
    readsOnlyWithin: z.array(NonEmptyText).min(1).optional(),
    anyOf: z.array(RulePredicateSchema).optional(),
    allOf: z.array(RulePredicateSchema).optional(),
    not: RulePredicateSchema.optional(),
  }),
);

const RuleText = z.string().trim().min(1).max(MAX_RULE_TEXT_CHARS);

export const PolicyRuleSchema = z
  .strictObject({
    id: z.string().min(1).max(MAX_RULE_ID_CHARS).regex(RULE_ID_PATTERN, 'a rule id is lowercase words joined by dashes'),
    tools: z.array(NonEmptyText).optional(),
    harnesses: z.array(NonEmptyText).optional(),
    actor: z.enum(RULE_ACTORS).optional(),
    presence: z.enum(RULE_PRESENCES).optional(),
    models: z.array(NonEmptyText).optional(),
    appliesTo: z.enum(RULE_COVERAGES).optional(),
    decision: z.enum(RULE_DECISIONS),
    when: RulePredicateSchema,
    reason: RuleText,
    alternative: RuleText.optional(),
    escape: z.strictObject({ commandMarker: NonEmptyText }).optional(),
  })
  .refine((rule) => rule.decision !== 'deny' || rule.alternative !== undefined, {
    message: 'a deny rule requires an alternative the session can follow',
    path: ['alternative'],
  });
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyProfileSchema = z.strictObject({
  extends: NonEmptyText.optional(),
  rules: z.array(NonEmptyText),
  mode: z.enum(PROFILE_MODES).optional(),
});
export type PolicyProfile = z.infer<typeof PolicyProfileSchema>;

export const POLICY_DOCUMENT_VERSION = 1;

export const CommandPolicyDocumentSchema = z.strictObject({
  version: z.literal(POLICY_DOCUMENT_VERSION),
  mode: z.enum(POLICY_MODES),
  profiles: z.record(z.string(), PolicyProfileSchema),
  roleToProfile: z.record(z.string(), z.string()),
  rules: z.array(PolicyRuleSchema),
});
export type CommandPolicyDocument = z.infer<typeof CommandPolicyDocumentSchema>;

/** The user's file: every key is optional because it only states what differs from the delivered document. */
export const CommandPolicyOverrideSchema = z.strictObject({
  version: z.literal(POLICY_DOCUMENT_VERSION),
  mode: z.enum(POLICY_MODES).optional(),
  disabledRules: z.array(NonEmptyText).optional(),
  rules: z.array(PolicyRuleSchema).optional(),
  profiles: z.record(z.string(), PolicyProfileSchema).optional(),
  roleToProfile: z.record(z.string(), z.string()).optional(),
});
export type CommandPolicyOverride = z.infer<typeof CommandPolicyOverrideSchema>;

export type PolicyPresence = 'attended' | 'unattended';
export type PolicyActor = 'session' | 'subagent';
export type PolicySource = 'pre_tool_use' | 'permission_request';

/** What a harness tells the policy about one tool call. `presence` is computed by the daemon, never read from the session. */
export interface PolicyRequest {
  sessionId: string;
  harness: HarnessId;
  role?: string;
  model?: string;
  presence: PolicyPresence;
  actor: PolicyActor;
  source: PolicySource;
  toolName: string;
  command?: string;
  filePaths?: string[];
  cwd: string;
  worktreeRoot?: string;
  scratchRoots: string[];
  toolResultsRoot?: string;
}

export interface ObservedRefusal { ruleId: string; reason: string; alternative?: string }

export type PolicyVerdict =
  | { decision: 'allow'; allowedBy?: string; observed?: ObservedRefusal; degraded?: 'limit_exceeded' }
  | { decision: 'deny'; ruleId: string; reason: string; alternative: string }
  | { decision: 'ask'; ruleId: string; reason: string };

export type DenialSource = 'policy' | 'cli_ask';
/** `observed` is a refusal the policy only watched: the session was let through. */
export type DenialOutcome = 'denied' | 'observed';

/** One line of the journal of refused commands. */
export interface DeniedCommand {
  id: string;
  sessionId: string;
  managerId: string;
  role?: string;
  profile: string;
  harness: HarnessId;
  ruleId: string;
  decisionSource: DenialSource;
  outcome: DenialOutcome;
  toolName: string;
  commandExcerpt: string;
  alternative?: string;
  actor: PolicyActor;
  createdAt: string;
}
