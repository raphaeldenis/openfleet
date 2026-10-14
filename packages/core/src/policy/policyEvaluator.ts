import type { CommandPolicyDocument, PolicyProfile, PolicyRequest, PolicyRule, PolicyVerdict } from '@openfleet/shared';
import { analyzeCommand, type CommandAnalysis } from './commandAnalyzer.js';
import { matchesPredicate, type PredicateContext } from './commandPredicates.js';

const DEFAULT_PROFILE = 'default';
const BASH_TOOL = 'Bash';
const ALLOW: PolicyVerdict = { decision: 'allow' };

interface ProfilePlan { ruleIds: string[]; isObserving: boolean }

const caseInsensitiveIncludes = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());
const hasProfile = (profiles: Record<string, PolicyProfile>, name: string): boolean => Object.hasOwn(profiles, name);

function profileNameFor(role: string | undefined, policy: CommandPolicyDocument): string {
  if (role === undefined) return DEFAULT_PROFILE;
  const wanted = role.toLowerCase();
  const mapping = Object.entries(policy.roleToProfile).find(([mappedRole]) => mappedRole.toLowerCase() === wanted);
  return mapping === undefined ? DEFAULT_PROFILE : mapping[1];
}

/** Names the profile a role is judged by: the mapped one, or `default` when the role maps to nothing that exists. */
export function profileNameOf(role: string | undefined, policy: CommandPolicyDocument): string {
  const mappedName = profileNameFor(role, policy);
  return hasProfile(policy.profiles, mappedName) ? mappedName : DEFAULT_PROFILE;
}

/** Lists the rule ids a profile applies, the ones it inherits through `extends` first. */
export function ruleIdsOfProfile(profiles: Record<string, PolicyProfile>, name: string, visited: Set<string> = new Set()): string[] {
  if (visited.has(name) || !hasProfile(profiles, name)) return [];
  visited.add(name);
  const profile = profiles[name] as PolicyProfile;
  const inherited = profile.extends === undefined ? [] : ruleIdsOfProfile(profiles, profile.extends, visited);
  return [...inherited, ...profile.rules];
}

function planFor(request: PolicyRequest, policy: CommandPolicyDocument): ProfilePlan {
  const mappedName = profileNameFor(request.role, policy);
  const name = hasProfile(policy.profiles, mappedName) ? mappedName : DEFAULT_PROFILE;
  const profile = hasProfile(policy.profiles, name) ? policy.profiles[name] : undefined;
  const isObserving = policy.mode === 'observe' || profile?.mode === 'observe';
  return { ruleIds: [...new Set(ruleIdsOfProfile(policy.profiles, name, new Set()))], isObserving };
}

function isInScope(rule: PolicyRule, request: PolicyRequest): boolean {
  const { model } = request;
  const toolMatches = rule.tools === undefined || rule.tools.includes(request.toolName);
  const harnessMatches = rule.harnesses === undefined || rule.harnesses.includes(request.harness);
  const actorMatches = rule.actor === undefined || rule.actor === 'any' || rule.actor === request.actor;
  const presenceMatches = rule.presence === undefined || rule.presence === 'any' || rule.presence === request.presence;
  const modelMatches = rule.models === undefined || (model !== undefined && rule.models.some((alias) => caseInsensitiveIncludes(model, alias)));
  return toolMatches && harnessMatches && actorMatches && presenceMatches && modelMatches;
}

function isEscapedByMarker(rule: PolicyRule, request: PolicyRequest): boolean {
  const marker = rule.escape?.commandMarker;
  const isAttended = request.presence === 'attended';
  return marker !== undefined && isAttended && typeof request.command === 'string' && request.command.includes(marker);
}

function contextsOf(request: PolicyRequest, analysis: CommandAnalysis | undefined): PredicateContext[] {
  if (analysis !== undefined) return analysis.commands.map((command) => ({ command, writtenPaths: [], request }));
  return [{ writtenPaths: request.filePaths ?? [], request }];
}

function ruleMatches(rule: PolicyRule, contexts: PredicateContext[], analysis: CommandAnalysis | undefined): boolean {
  const mustCoverEveryCommand = rule.appliesTo === 'everyCommand';
  if (!mustCoverEveryCommand) return contexts.some((context) => matchesPredicate(rule.when, context));
  const isFullyRead = analysis?.status === 'complete' && contexts.length > 0;
  return isFullyRead && contexts.every((context) => matchesPredicate(rule.when, context));
}

function refusalOf(rule: PolicyRule, isObserving: boolean): PolicyVerdict {
  if (isObserving) return { decision: 'allow', observed: { ruleId: rule.id, reason: rule.reason, ...(rule.alternative === undefined ? {} : { alternative: rule.alternative }) } };
  if (rule.decision === 'ask') return { decision: 'ask', ruleId: rule.id, reason: rule.reason };
  return { decision: 'deny', ruleId: rule.id, reason: rule.reason, alternative: rule.alternative ?? '' };
}

function applicableRulesOf(plan: ProfilePlan, policy: CommandPolicyDocument, request: PolicyRequest): PolicyRule[] {
  const rulesById = new Map(policy.rules.map((rule) => [rule.id, rule]));
  return plan.ruleIds.flatMap((ruleId) => {
    const rule = rulesById.get(ruleId);
    return rule !== undefined && isInScope(rule, request) && !isEscapedByMarker(rule, request) ? [rule] : [];
  });
}

function matchesWithoutFailing(rule: PolicyRule, contexts: PredicateContext[], analysis: CommandAnalysis | undefined): boolean {
  try {
    return ruleMatches(rule, contexts, analysis);
  } catch {
    return false;
  }
}

/**
 * Decides what a tool call may do. The profile of the request role lists the rules in order: the first rule that
 * refuses wins, an allow rule only vouches for the call when nothing refuses it, and everything else is allowed.
 * A rule that cannot be evaluated is skipped, so one broken rule never blocks the others.
 */
export function evaluateCommandPolicy(request: PolicyRequest, policy: CommandPolicyDocument): PolicyVerdict {
  if (policy.mode === 'off') return ALLOW;
  const isBashCall = request.toolName === BASH_TOOL;
  const readsACommand = isBashCall && typeof request.command === 'string';
  if (isBashCall && !readsACommand) return ALLOW;
  const analysis = readsACommand ? analyzeCommand(request.command as string) : undefined;
  if (analysis?.status === 'limit_exceeded') return { decision: 'allow', degraded: 'limit_exceeded' };
  const contexts = contextsOf(request, analysis);
  const plan = planFor(request, policy);
  let allowedBy: string | undefined;
  for (const rule of applicableRulesOf(plan, policy, request)) {
    if (!matchesWithoutFailing(rule, contexts, analysis)) continue;
    if (rule.decision !== 'allow') return refusalOf(rule, plan.isObserving);
    allowedBy ??= rule.id;
  }
  return allowedBy === undefined ? ALLOW : { decision: 'allow', allowedBy };
}
