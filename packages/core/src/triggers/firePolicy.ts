import type { TriggerFireReason } from '@openfleet/shared';
import type { FireLedger, TriggerFire } from './fireLedger.js';
import type { TriggerRecord } from './triggerRepository.js';

export type PolicyVerdict = { verdict: 'proceed' } | { verdict: 'cancel'; reason: TriggerFireReason } | { verdict: 'hold'; waitMs: number };

const localDayBoundsIso = (now: number): { fromIso: string; untilIso: string } => {
  const moment = new Date(now);
  const fromIso = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).toISOString();
  const untilIso = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + 1).toISOString();
  return { fromIso, untilIso };
};

/** Judges a fire against the policy of its trigger: the daily cap first, then the cooldown, which a per_batch trigger turns into a wait. */
export function policyVerdictOf(input: { trigger: TriggerRecord; fire: TriggerFire; ledger: FireLedger; now: number }): PolicyVerdict {
  const { trigger, fire, ledger, now } = input;
  const { maxFiresPerDay, cooldownSeconds, batchMode } = trigger.policy;

  const firesToday = ledger.countEffectsStartedBetween({ triggerId: trigger.id, ...localDayBoundsIso(now), exceptId: fire.id });
  const isOverTheDailyCap = maxFiresPerDay !== undefined && firesToday >= maxFiresPerDay;
  if (isOverTheDailyCap) return { verdict: 'cancel', reason: 'daily_cap' };

  const latestEffectAt = ledger.latestReachedEffectAt({ triggerId: trigger.id, exceptId: fire.id });
  const cooldownEndsAt = latestEffectAt === undefined ? 0 : Date.parse(latestEffectAt) + cooldownSeconds * 1000;
  const isInCooldown = cooldownSeconds > 0 && now < cooldownEndsAt;
  if (!isInCooldown) return { verdict: 'proceed' };
  return batchMode === 'per_batch' ? { verdict: 'hold', waitMs: cooldownEndsAt - now } : { verdict: 'cancel', reason: 'cooldown' };
}
