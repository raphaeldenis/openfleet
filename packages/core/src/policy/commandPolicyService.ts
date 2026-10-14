import {
  CommandPolicyOverrideSchema, OpenFleetError, UnattendedOverrideSchema,
  type CommandPolicyDocument, type CommandPolicyEvaluateResult, type CommandPolicyRuleView, type CommandPolicyView, type PolicyRequest, type PolicyRule,
} from '@openfleet/shared';
import { isDeepStrictEqual } from 'node:util';
import { readableConfigReason } from '../configReason.js';
import { log } from '../logger.js';
import { CommandPolicyFileUnreadableError } from './commandPolicyErrors.js';
import type { CommandPolicySettings, PolicyEvaluate } from './commandPolicySettings.js';
import { resolveCommandPolicy, validPartsOfOverride, type PolicyDocumentIssue } from './policyDocument.js';
import { profileNameOf, ruleIdsOfProfile } from './policyEvaluator.js';

/** Where the override lives: the text of the file, or nothing when there is none. A write replaces the whole file or fails whole. */
export interface PolicyFile {
  read(): string | undefined;
  write(contents: string): void;
  /** Copies the current file next to itself under a new name and returns that name. */
  keepCopy(): string;
}

export interface CommandPolicyServiceDeps {
  /** The delivered settings: what applies when no override says otherwise. */
  base: CommandPolicySettings;
  file: PolicyFile;
  evaluate: PolicyEvaluate;
}

interface LoadedOverride {
  /** What the file says, as the JSON object it is; absent when there is no file or it is not an object. */
  saved: Record<string, unknown> | undefined;
  issues: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function describeIssue(issue: PolicyDocumentIssue): string {
  if (issue.scope === 'document') return issue.message;
  if (issue.scope === 'field') return `${issue.field}: ${issue.message}`;
  if (issue.scope === 'profile') return `profile ${issue.profile}: ${issue.message}`;
  return `rule ${issue.ruleId ?? `#${issue.index}`}: ${issue.message}`;
}

function parseSavedOverride(text: string | undefined): LoadedOverride {
  if (text === undefined) return { saved: undefined, issues: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) return { saved: parsed, issues: [] };
    return { saved: undefined, issues: ['the command policy file is not a JSON object'] };
  } catch (error) {
    return { saved: undefined, issues: [`the command policy file is not valid JSON: ${readableConfigReason(error)}`] };
  }
}

/**
 * The single source of truth for what the daemon enforces. It merges the delivered settings with the override saved in
 * the policy file, hands the merged settings to whoever decides (`settings()` returns the current ones at each call),
 * and replaces them as soon as a valid override is saved, with no restart.
 */
export class CommandPolicyService {
  private effective: CommandPolicySettings;
  private saved: Record<string, unknown> | undefined;
  private issues: string[];

  constructor(private readonly deps: CommandPolicyServiceDeps) {
    const loaded = this.loadSavedOverride();
    const merged = this.mergeOverride(loaded);
    this.saved = loaded.saved;
    this.effective = merged.settings;
    this.issues = merged.issues;
  }

  settings(): CommandPolicySettings {
    return this.effective;
  }

  view(): CommandPolicyView {
    const { document, unattended } = this.effective;
    return {
      mode: document.mode,
      unattended: { askBecomesDeny: unattended.askBecomesDeny },
      rules: this.ruleViews(),
      override: this.saved === undefined ? null : validPartsOfOverride({ delivered: this.deps.base.document, override: this.saved }),
      issues: this.issues,
    };
  }

  /** Judges one tried command with the current document. Nothing is journaled and nothing runs. */
  evaluate(request: PolicyRequest): CommandPolicyEvaluateResult {
    const { document } = this.effective;
    return { verdict: this.deps.evaluate(request, document), mode: document.mode, profile: profileNameOf(request.role, document) };
  }

  /** Validates the whole override, writes it, and only then enforces it. A document with anything invalid changes nothing. */
  replace(raw: unknown): CommandPolicyView {
    const override = CommandPolicyOverrideSchema.parse(raw);
    const { issues } = resolveCommandPolicy({ delivered: this.deps.base.document, override });
    if (issues.length > 0) throw new OpenFleetError('invalid_body', 'the command policy is invalid.', { detail: issues.map(describeIssue) });
    const onDisk = this.refuseToOverwriteAnUnreadableFile();
    const previousFileKeptAs = this.keepHandEditedFile(onDisk);

    this.deps.file.write(`${JSON.stringify(override, null, 2)}\n`);

    const { settings, issues: remainingIssues } = this.mergeOverride({ saved: override, issues: [] });
    this.effective = settings;
    this.saved = override;
    this.issues = remainingIssues;
    log('info', 'command policy saved', undefined, { mode: settings.document.mode, askBecomesDeny: settings.unattended.askBecomesDeny, disabledRules: override.disabledRules?.length ?? 0, addedRules: override.rules?.length ?? 0 });
    return { ...this.view(), ...(previousFileKeptAs === undefined ? {} : { previousFileKeptAs }) };
  }

  private loadSavedOverride(): LoadedOverride {
    try {
      const loaded = parseSavedOverride(this.deps.file.read());
      if (loaded.issues.length > 0) log('warn', `command policy file ignored, the delivered policy applies: ${loaded.issues.join('; ')}`);
      return loaded;
    } catch (error) {
      const issue = `the command policy file cannot be read: ${readableConfigReason(error)}`;
      log('warn', `command policy file ignored, the delivered policy applies: ${issue}`);
      return { saved: undefined, issues: [issue] };
    }
  }

  private refuseToOverwriteAnUnreadableFile(): LoadedOverride {
    const onDisk = parseSavedOverride(this.deps.file.read());
    if (onDisk.issues.length > 0) throw new CommandPolicyFileUnreadableError(onDisk.issues.join('; '));
    return onDisk;
  }

  /** A file the daemon did not write, or one with parts it ignores, is copied aside before the save replaces it. */
  private keepHandEditedFile({ saved: onDisk }: LoadedOverride): string | undefined {
    if (onDisk === undefined) return undefined;
    const hasPartsTheDaemonIgnores = !isDeepStrictEqual(onDisk, validPartsOfOverride({ delivered: this.deps.base.document, override: onDisk }));
    const wasEditedSinceTheDaemonRead = !isDeepStrictEqual(onDisk, this.saved);
    return hasPartsTheDaemonIgnores || wasEditedSinceTheDaemonRead ? this.deps.file.keepCopy() : undefined;
  }

  private mergeOverride({ saved, issues }: LoadedOverride): { settings: CommandPolicySettings; issues: string[] } {
    const { base } = this.deps;
    const { policy, issues: documentIssues } = resolveCommandPolicy({ delivered: base.document, override: saved });
    const unattended = UnattendedOverrideSchema.safeParse(saved?.unattended ?? {});
    const unattendedIssues = unattended.success ? [] : [`unattended: ${readableConfigReason(unattended.error)}`];
    const askBecomesDeny = (unattended.success ? unattended.data.askBecomesDeny : undefined) ?? base.unattended.askBecomesDeny;
    return {
      settings: { document: policy, unattended: { ...base.unattended, askBecomesDeny } },
      issues: [...issues, ...documentIssues.map(describeIssue), ...unattendedIssues],
    };
  }

  private ruleViews(): CommandPolicyRuleView[] {
    const { document } = this.effective;
    const deliveredIds = new Set(this.deps.base.document.rules.map((rule) => rule.id));
    const disabledIds = new Set(Array.isArray(this.saved?.disabledRules) ? (this.saved.disabledRules as string[]) : []);
    const currentRuleById = new Map(document.rules.map((rule) => [rule.id, rule]));
    const deliveredViews = this.deps.base.document.rules.map((delivered) => {
      const current = currentRuleById.get(delivered.id);
      const isDisabled = disabledIds.has(delivered.id);
      const isReplaced = current !== undefined && current !== delivered;
      return this.viewOf(isDisabled ? delivered : (current ?? delivered), document, { origin: isReplaced ? 'custom' : 'delivered', enabled: !isDisabled });
    });
    const customViews = document.rules.filter((rule) => !deliveredIds.has(rule.id)).map((rule) => this.viewOf(rule, document, { origin: 'custom', enabled: true }));
    return [...deliveredViews, ...customViews];
  }

  private viewOf(rule: PolicyRule, document: CommandPolicyDocument, { origin, enabled }: Pick<CommandPolicyRuleView, 'origin' | 'enabled'>): CommandPolicyRuleView {
    const profiles = Object.keys(document.profiles).filter((name) => ruleIdsOfProfile(document.profiles, name).includes(rule.id));
    return {
      id: rule.id, origin, decision: rule.decision, enabled, profiles, presence: rule.presence ?? 'any', reason: rule.reason,
      ...(rule.alternative === undefined ? {} : { alternative: rule.alternative }),
    };
  }
}
