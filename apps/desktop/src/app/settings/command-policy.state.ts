import { computed, inject, Injectable, signal } from '@angular/core';
import type { CommandPolicyEvaluateResult, CommandPolicyOverride, CommandPolicyView, DeniedCommand, PolicyMode } from '@openfleet/shared';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

export type TriedPresence = 'unattended' | 'attended';

export interface TriedCommand {
  command: string;
  role: string;
  presence: TriedPresence;
}

/** What the screen says about a tried command: one headline, the lines under it, and whether the policy would stop the command. */
export interface TryOutcome {
  headline: string;
  details: string[];
  isRefusal: boolean;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; what: string }
  | { kind: 'failed'; cause: string };

const POLICY_FILE_NAME = 'command-policy.json';
const GENERIC_SAVE_FAILURE = 'Something went wrong. Nothing was changed.';
const GENERIC_TRY_FAILURE = 'The daemon could not judge this command. Try again.';

function describeSaveFailure(failure: unknown): string {
  if (!(failure instanceof ApiError)) return GENERIC_SAVE_FAILURE;
  const isReadOnly = failure.status === 409 && failure.code === 'config_read_only';
  if (isReadOnly) return `${POLICY_FILE_NAME} is read-only. Nothing was changed.`;
  const isUnreadable = failure.status === 409 && failure.code === 'config_unreadable';
  if (isUnreadable) return `${POLICY_FILE_NAME} can’t be read: fix it by hand, then try again. Nothing was changed.`;
  const isRefused = failure.status === 400;
  if (isRefused) return 'The daemon refused this policy. Nothing was changed.';
  return GENERIC_SAVE_FAILURE;
}

function profileLine({ profile, mode }: Pick<CommandPolicyEvaluateResult, 'profile' | 'mode'>): string {
  return `Judged by the ${profile} profile, policy mode ${mode}.`;
}

/** Turns the verdict of the daemon into the sentences of the "Try a command" result. */
export function describeTryResult(result: CommandPolicyEvaluateResult): TryOutcome {
  const { verdict } = result;
  if (verdict.decision === 'deny') {
    return { headline: `Refused by ${verdict.ruleId}`, details: [verdict.reason, `Alternative: ${verdict.alternative}`, profileLine(result)], isRefusal: true };
  }
  if (verdict.decision === 'ask') {
    return { headline: `A person would be asked (${verdict.ruleId})`, details: [verdict.reason, 'A session nobody watches gets a refusal instead.', profileLine(result)], isRefusal: false };
  }
  if (verdict.observed) {
    const { ruleId, reason, alternative } = verdict.observed;
    const alternativeLine = alternative === undefined ? [] : [`Alternative: ${alternative}`];
    return { headline: `Allowed: ${ruleId} would refuse it, but the policy only observes`, details: [reason, ...alternativeLine, profileLine(result)], isRefusal: false };
  }
  if (verdict.allowedBy !== undefined) return { headline: `Allowed by ${verdict.allowedBy}`, details: [profileLine(result)], isRefusal: false };
  return { headline: 'Allowed: no rule refuses it', details: [profileLine(result)], isRefusal: false };
}

/** The command policy as the daemon holds it, the refusals it journaled, and the saves and tries made from the screen. Lives as long as the section. */
@Injectable()
export class CommandPolicyState {
  private readonly api = inject(FleetApiService);

  readonly view = signal<CommandPolicyView | null>(null);
  readonly hasFailedToLoad = signal(false);
  readonly saveState = signal<SaveState>({ kind: 'idle' });
  readonly denials = signal<DeniedCommand[]>([]);
  readonly hasFailedToLoadDenials = signal(false);
  readonly nextDenialsCursor = signal<string | undefined>(undefined);
  readonly tryOutcome = signal<TryOutcome | null>(null);
  readonly tryFailure = signal<string | null>(null);
  readonly isTrying = signal(false);

  readonly isSaving = computed(() => this.saveState().kind === 'saving');
  readonly saveStatusMessage = computed(() => {
    const state = this.saveState();
    if (state.kind === 'saving') return 'Saving…';
    if (state.kind === 'saved') return `✓ Saved: ${state.what}. Applies to the next command of every session.`;
    return '';
  });

  async load(): Promise<void> {
    const [viewResult] = await Promise.all([this.api.commandPolicy().then((view) => ({ view }), () => undefined), this.loadDenials()]);
    if (viewResult) this.view.set(viewResult.view);
    else this.hasFailedToLoad.set(true);
  }

  /** Replaces the list with its newest page. */
  async loadDenials(): Promise<void> {
    try {
      const page = await this.api.commandPolicyDenials();
      this.denials.set(page.items);
      this.nextDenialsCursor.set(page.nextCursor);
      this.hasFailedToLoadDenials.set(false);
    } catch {
      this.hasFailedToLoadDenials.set(true);
    }
  }

  async loadMoreDenials(): Promise<void> {
    const cursor = this.nextDenialsCursor();
    if (cursor === undefined) return;
    try {
      const page = await this.api.commandPolicyDenials({ cursor });
      this.denials.update((shown) => [...shown, ...page.items]);
      this.nextDenialsCursor.set(page.nextCursor);
    } catch {
      this.hasFailedToLoadDenials.set(true);
    }
  }

  setMode(mode: PolicyMode): Promise<void> {
    return this.save((saved) => ({ ...saved, mode }), `mode ${mode}`);
  }

  setAskBecomesDeny(askBecomesDeny: boolean): Promise<void> {
    return this.save((saved) => ({ ...saved, unattended: { ...saved.unattended, askBecomesDeny } }), `permission dialogs of unattended sessions ${askBecomesDeny ? 'are refused' : 'go to the approval flow'}`);
  }

  setRuleEnabled(ruleId: string, isEnabled: boolean): Promise<void> {
    const change = (saved: CommandPolicyOverride): CommandPolicyOverride => {
      const otherDisabledRules = (saved.disabledRules ?? []).filter((id) => id !== ruleId);
      return { ...saved, disabledRules: isEnabled ? otherDisabledRules : [...otherDisabledRules, ruleId] };
    };
    return this.save(change, `${ruleId} ${isEnabled ? 'enabled' : 'disabled'}`);
  }

  async tryCommand({ command, role, presence }: TriedCommand): Promise<void> {
    this.isTrying.set(true);
    this.tryFailure.set(null);
    try {
      const trimmedRole = role.trim();
      const result = await this.api.tryCommandPolicy({ command, presence, ...(trimmedRole === '' ? {} : { role: trimmedRole }) });
      this.tryOutcome.set(describeTryResult(result));
    } catch {
      this.tryOutcome.set(null);
      this.tryFailure.set(GENERIC_TRY_FAILURE);
    } finally {
      this.isTrying.set(false);
    }
  }

  private async save(change: (saved: CommandPolicyOverride) => CommandPolicyOverride, what: string): Promise<void> {
    if (this.isSaving()) return;
    const saved = this.view()?.override ?? { version: 1 as const };
    this.saveState.set({ kind: 'saving' });
    try {
      this.view.set(await this.api.saveCommandPolicy(change(saved)));
      this.saveState.set({ kind: 'saved', what });
    } catch (failure) {
      this.saveState.set({ kind: 'failed', cause: describeSaveFailure(failure) });
    }
  }
}
