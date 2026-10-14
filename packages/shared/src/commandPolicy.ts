import * as z from 'zod';
import { HARNESSES, type HarnessId } from './session.js';

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

/** `askBecomesDeny` is the fine switch of the incident: false gives back the permission dialog nobody sees to a child. */
export const UnattendedOverrideSchema = z.strictObject({ askBecomesDeny: z.boolean().optional() });

/** The user's file: every key is optional because it only states what differs from the delivered document. */
export const CommandPolicyOverrideSchema = z.strictObject({
  version: z.literal(POLICY_DOCUMENT_VERSION),
  mode: z.enum(POLICY_MODES).optional(),
  unattended: UnattendedOverrideSchema.optional(),
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

/** One rule as the settings screen lists it: the delivered rules stay listed when the override disables them. */
export interface CommandPolicyRuleView {
  id: string;
  origin: 'delivered' | 'custom';
  decision: (typeof RULE_DECISIONS)[number];
  enabled: boolean;
  /** The profiles that list the rule, inherited ones included. */
  profiles: string[];
  presence: (typeof RULE_PRESENCES)[number];
  reason: string;
  alternative?: string;
}

/** What `GET` and `PUT /api/command-policy` answer: the state the daemon enforces right now and the override that produced it. */
export interface CommandPolicyView {
  mode: PolicyMode;
  unattended: { askBecomesDeny: boolean };
  rules: CommandPolicyRuleView[];
  /** The valid parts of the saved override, or null when no file exists: saving it back is always accepted. */
  override: CommandPolicyOverride | null;
  /** Why parts of the saved file are ignored; empty when the file applies whole. */
  issues: string[];
  /** Only on the answer of a save: the name the hand-edited file was kept under, next to the new one. */
  previousFileKeptAs?: string;
}

const MAX_TRIED_COMMAND_CHARS = 64 * 1024;

/** The body of `POST /api/command-policy/evaluate`: what a session would send, with the defaults of a child nobody watches. */
export const CommandPolicyEvaluateRequestSchema = z.strictObject({
  command: z.string().min(1).max(MAX_TRIED_COMMAND_CHARS),
  role: z.string().min(1).optional(),
  presence: z.enum(['attended', 'unattended']).default('unattended'),
  harness: z.enum(HARNESSES).default('claude-cli'),
  cwd: z.string().min(1).default('/'),
  toolName: z.string().min(1).default('Bash'),
  actor: z.enum(['session', 'subagent']).default('session'),
  model: z.string().min(1).optional(),
});
export type CommandPolicyEvaluateRequest = z.input<typeof CommandPolicyEvaluateRequestSchema>;

/** The verdict the policy gives, with the mode it was given in and the profile that judged: nothing is run, nothing is journaled. */
export interface CommandPolicyEvaluateResult {
  verdict: PolicyVerdict;
  mode: PolicyMode;
  profile: string;
}

/** One page of the journal, newest first; `nextCursor` is absent on the last page. */
export interface DeniedCommandPage {
  items: DeniedCommand[];
  nextCursor?: string;
}

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
