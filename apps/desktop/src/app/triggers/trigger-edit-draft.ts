import { TRIGGER_BACKLOG_POLICIES, TRIGGER_BATCH_MODES, type TriggerPolicy, type TriggerWhen } from '@openfleet/shared';
import type { TriggerView } from '../core/playbook-trigger-views';
import { isSameWhenDraft, whenDraftOf, whenOrProblemOf, type WhenDraft } from './when-draft';

/**
 * What the form holds while the human types: the numbers stay text until they are checked.
 * The draft carries the revision, the policy, the WHEN and the owner it was opened from, so a save answers to what the human edited, whatever the list shows since.
 * A WHEN this screen cannot rebuild without losing a field has no draft: it is shown and left as stored.
 */
export interface TriggerEditDraft {
  title: string;
  cooldownSeconds: string;
  maxFiresPerDay: string;
  batchMode: TriggerPolicy['batchMode'];
  backlogPolicy: TriggerPolicy['backlogPolicy'];
  when: WhenDraft | undefined;
  ownerManagerId: string | null;
  openedAtRev: number;
  openedWithPolicy: TriggerPolicy;
  openedWithWhen: WhenDraft | undefined;
  openedWithOwnerManagerId: string | null;
}

/** What a save sends beyond the title and the policy: only the parts the human changed. */
export interface TriggerEditChanges {
  title: string;
  policy: TriggerPolicy;
  when?: TriggerWhen;
  ownerManagerId?: string | null;
}

export const BATCH_MODES = TRIGGER_BATCH_MODES;
export const BACKLOG_POLICIES = TRIGGER_BACKLOG_POLICIES;

const hasNoDailyCap = (draft: TriggerEditDraft) => draft.maxFiresPerDay.trim() === '';
const isWholeNumberFrom = (text: string, minimum: number) => /^\d+$/.test(text.trim()) && Number(text) >= minimum;

export function draftOf(trigger: TriggerView): TriggerEditDraft {
  const { cooldownSeconds, maxFiresPerDay, batchMode, backlogPolicy } = trigger.policy;
  const when = whenDraftOf(trigger.when);
  return {
    title: trigger.title, cooldownSeconds: String(cooldownSeconds), maxFiresPerDay: maxFiresPerDay === undefined ? '' : String(maxFiresPerDay), batchMode, backlogPolicy,
    when, ownerManagerId: trigger.ownerManagerId,
    openedAtRev: trigger.contentRev, openedWithPolicy: trigger.policy, openedWithWhen: when, openedWithOwnerManagerId: trigger.ownerManagerId,
  };
}

function problemOfWhenDraft(draft: TriggerEditDraft): string | undefined {
  if (draft.when === undefined) return undefined;
  const checked = whenOrProblemOf(draft.when);
  return 'problem' in checked ? checked.problem : undefined;
}

/** Says what is wrong with the draft in one French sentence, or nothing when it can be saved. */
export function problemOfDraft(draft: TriggerEditDraft): string | undefined {
  if (!isWholeNumberFrom(draft.cooldownSeconds, 0)) return 'Le repos doit être un nombre entier de secondes, 0 ou plus.';
  if (!hasNoDailyCap(draft) && !isWholeNumberFrom(draft.maxFiresPerDay, 1)) return 'Le plafond par jour doit être un nombre entier, 1 ou plus, ou rester vide.';
  return problemOfWhenDraft(draft);
}

function changedWhenOf(draft: TriggerEditDraft): { when: TriggerWhen } | Record<string, never> {
  const { when, openedWithWhen } = draft;
  const isUnchanged = when === undefined || (openedWithWhen !== undefined && isSameWhenDraft(when, openedWithWhen));
  if (isUnchanged) return {};
  const checked = whenOrProblemOf(when);
  return 'when' in checked ? { when: checked.when } : {};
}

const changedOwnerOf = (draft: TriggerEditDraft) => (draft.ownerManagerId === draft.openedWithOwnerManagerId ? {} : { ownerManagerId: draft.ownerManagerId });

/** The fields a save sends; the policy fields the form does not show (the backlog age) keep the value they had when the form was opened. */
export function changesOf(draft: TriggerEditDraft): TriggerEditChanges {
  const { maxFiresPerDay: _removedCap, ...policyWithoutCap } = draft.openedWithPolicy;
  const dailyCap = hasNoDailyCap(draft) ? {} : { maxFiresPerDay: Number(draft.maxFiresPerDay) };
  const policy: TriggerPolicy = { ...policyWithoutCap, ...dailyCap, cooldownSeconds: Number(draft.cooldownSeconds), batchMode: draft.batchMode, backlogPolicy: draft.backlogPolicy };
  return { title: draft.title, policy, ...changedWhenOf(draft), ...changedOwnerOf(draft) };
}
