import { TRIGGER_BACKLOG_POLICIES, TRIGGER_BATCH_MODES, type TriggerPolicy } from '@openfleet/shared';
import type { TriggerView } from '../core/playbook-trigger-views';

/**
 * What the form holds while the human types: the numbers stay text until they are checked.
 * The draft carries the revision and the policy it was opened from, so a save answers to what the human edited, whatever the list shows since.
 */
export interface TriggerEditDraft {
  title: string;
  cooldownSeconds: string;
  maxFiresPerDay: string;
  batchMode: TriggerPolicy['batchMode'];
  backlogPolicy: TriggerPolicy['backlogPolicy'];
  openedAtRev: number;
  openedWithPolicy: TriggerPolicy;
}

export const BATCH_MODES = TRIGGER_BATCH_MODES;
export const BACKLOG_POLICIES = TRIGGER_BACKLOG_POLICIES;

const hasNoDailyCap = (draft: TriggerEditDraft) => draft.maxFiresPerDay.trim() === '';
const isWholeNumberFrom = (text: string, minimum: number) => /^\d+$/.test(text.trim()) && Number(text) >= minimum;

export function draftOf(trigger: TriggerView): TriggerEditDraft {
  const { cooldownSeconds, maxFiresPerDay, batchMode, backlogPolicy } = trigger.policy;
  return {
    title: trigger.title, cooldownSeconds: String(cooldownSeconds), maxFiresPerDay: maxFiresPerDay === undefined ? '' : String(maxFiresPerDay), batchMode, backlogPolicy,
    openedAtRev: trigger.contentRev, openedWithPolicy: trigger.policy,
  };
}

/** Says what is wrong with the draft in one French sentence, or nothing when it can be saved. */
export function problemOfDraft(draft: TriggerEditDraft): string | undefined {
  if (!isWholeNumberFrom(draft.cooldownSeconds, 0)) return 'Le repos doit être un nombre entier de secondes, 0 ou plus.';
  if (!hasNoDailyCap(draft) && !isWholeNumberFrom(draft.maxFiresPerDay, 1)) return 'Le plafond par jour doit être un nombre entier, 1 ou plus, ou rester vide.';
  return undefined;
}

/** The fields a save sends; the policy fields the form does not show (the backlog age) keep the value they had when the form was opened. */
export function changesOf(draft: TriggerEditDraft): { title: string; policy: TriggerPolicy } {
  const { maxFiresPerDay: _removedCap, ...policyWithoutCap } = draft.openedWithPolicy;
  const dailyCap = hasNoDailyCap(draft) ? {} : { maxFiresPerDay: Number(draft.maxFiresPerDay) };
  const policy: TriggerPolicy = { ...policyWithoutCap, ...dailyCap, cooldownSeconds: Number(draft.cooldownSeconds), batchMode: draft.batchMode, backlogPolicy: draft.backlogPolicy };
  return { title: draft.title, policy };
}
