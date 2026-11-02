import type { TriggerFireReason, TriggerLedgerState } from '@openfleet/shared';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import { evaluateConditions } from '../playbooks/kernel/conditionEvaluator.js';
import { log } from '../logger.js';
import type { FireLedger, TriggerFire } from './fireLedger.js';
import { kernelConditionsOf } from './kernelConditions.js';
import { approvedGraphOf } from './triggerService.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

export const MAX_EVENT_JSON_CHARS = 8192;
const MINUTE_MS = 60_000;
/** A discard_stale backlog with no explicit age keeps the fires of the last hour. */
export const DEFAULT_STALE_BACKLOG_MINUTES = 60;

/** What happened to the effect of a fire: it ran, or it did not and says why. */
export type ActionResult = { settlement: 'completed'; runId?: string } | { settlement: 'cancelled'; reason: TriggerFireReason };

export interface TriggerActions {
  perform(input: { trigger: TriggerRecord; fire: TriggerFire }): ActionResult;
}

export type SubmitResult =
  | { outcome: 'not_armed' | 'filtered' | 'event_too_large' }
  | { outcome: 'duplicate'; fireId: string }
  | { outcome: 'fired'; fireId: string; ledgerState: TriggerLedgerState };

export interface TriggerEngineDeps {
  triggers: Pick<TriggerRepository, 'get'>;
  ledger: FireLedger;
  actions: TriggerActions;
  clock: () => number;
  newId: () => string;
}

/** True when a human armed the trigger as it stands now: the armed digest still matches what would run. */
export const isArmedAsItStands = (trigger: TriggerRecord): boolean =>
  trigger.armedAt !== null && trigger.approvedGraphDigest === canonicalDigestOf(approvedGraphOf(trigger));

/**
 * Turns the events a source reports into fires. A fire is written to the ledger before anything happens for it, so a daemon that stops
 * at any point leaves a row that says how far the fire got. The guarantee is at most once per (trigger, dedup key), never exactly once.
 */
export class TriggerEngine {
  constructor(private readonly deps: TriggerEngineDeps) {}

  /** Offers one event of a source: it fires when the trigger is armed, its conditions hold and its dedup key is new. */
  submit(input: { triggerId: string; dedupKey: string; event: Record<string, unknown> }): SubmitResult {
    const { triggers, ledger, clock, newId } = this.deps;
    const trigger = triggers.get(input.triggerId);
    if (trigger === undefined || !isArmedAsItStands(trigger)) return { outcome: 'not_armed' };

    const holds = evaluateConditions(kernelConditionsOf(trigger.conditions), { event: input.event });
    if (!holds) return { outcome: 'filtered' };

    const eventJson = JSON.stringify(input.event);
    if (eventJson.length > MAX_EVENT_JSON_CHARS) return { outcome: 'event_too_large' };

    const accepted = ledger.accept({
      id: newId(), triggerId: trigger.id, dedupKey: input.dedupKey, firedAt: new Date(clock()).toISOString(), eventDigest: canonicalDigestOf(input.event), eventJson, chainDepth: 1,
    });
    if (!accepted.wasAccepted) return { outcome: 'duplicate', fireId: accepted.fire.id };

    const ledgerState = this.run({ trigger, fire: accepted.fire });
    return { outcome: 'fired', fireId: accepted.fire.id, ledgerState };
  }

  /**
   * Settles what a stopped daemon left behind: a fire it had attempted needs a human's review and is never replayed, and a fire it had only
   * accepted runs again when its backlog policy allows it for its age.
   */
  recover(): void {
    const { ledger, clock } = this.deps;
    const settledAt = new Date(clock()).toISOString();
    const interruptedCount = ledger.markInterruptedForReview(settledAt);
    if (interruptedCount > 0) log('warn', `${interruptedCount} trigger fire(s) were interrupted while they ran: they need a review and are not replayed`);
    this.replayAcceptedBacklog();
  }

  private replayAcceptedBacklog(): void {
    const { ledger, triggers } = this.deps;
    const acceptedByTrigger = new Map<string, TriggerFire[]>();
    for (const fire of ledger.listAccepted()) acceptedByTrigger.set(fire.triggerId, [...(acceptedByTrigger.get(fire.triggerId) ?? []), fire]);
    for (const [triggerId, fires] of acceptedByTrigger) {
      const trigger = triggers.get(triggerId);
      if (trigger === undefined) continue;
      this.replayBacklogOf(trigger, fires);
    }
  }

  private replayBacklogOf(trigger: TriggerRecord, acceptedFires: TriggerFire[]): void {
    const { ledger, clock } = this.deps;
    const now = clock();
    const cancel = (fire: TriggerFire, reason: TriggerFireReason) => ledger.markCancelled({ id: fire.id, settledAt: new Date(now).toISOString(), reason });
    if (!isArmedAsItStands(trigger)) return void acceptedFires.forEach((fire) => cancel(fire, 'disarmed'));

    const maxAgeMs = backlogMaxAgeMsOf(trigger);
    const isFreshEnough = (fire: TriggerFire) => maxAgeMs === undefined || now - Date.parse(fire.firedAt) <= maxAgeMs;
    const fresh = acceptedFires.filter(isFreshEnough);
    acceptedFires.filter((fire) => !isFreshEnough(fire)).forEach((fire) => cancel(fire, 'stale'));

    const toReplay = trigger.policy.backlogPolicy === 'fire_latest_only' ? fresh.slice(-1) : fresh;
    fresh.filter((fire) => !toReplay.includes(fire)).forEach((fire) => cancel(fire, 'superseded'));
    for (const fire of toReplay) this.run({ trigger, fire });
  }

  /** Writes `attempted`, runs the effect, then writes how it ended. */
  private run({ trigger, fire }: { trigger: TriggerRecord; fire: TriggerFire }): TriggerLedgerState {
    const { ledger, actions, clock } = this.deps;
    const stillOwnsTheFire = ledger.markAttempted(fire.id);
    if (!stillOwnsTheFire) return ledger.get(fire.id)?.ledgerState ?? 'cancelled';

    const result = this.performSafely({ trigger, fire });
    const settledAt = new Date(clock()).toISOString();
    if (result.settlement === 'completed') {
      ledger.markCompleted({ id: fire.id, settledAt, runId: result.runId });
      return 'completed';
    }
    ledger.markCancelled({ id: fire.id, settledAt, reason: result.reason });
    return 'cancelled';
  }

  private performSafely(input: { trigger: TriggerRecord; fire: TriggerFire }): ActionResult {
    try {
      return this.deps.actions.perform(input);
    } catch (error) {
      log('error', `the action of trigger ${input.trigger.id} failed for fire ${input.fire.id}`, error);
      return { settlement: 'cancelled', reason: 'action_failed' };
    }
  }
}

function backlogMaxAgeMsOf(trigger: TriggerRecord): number | undefined {
  const { backlogMaxAgeMinutes, backlogPolicy } = trigger.policy;
  if (backlogMaxAgeMinutes !== undefined) return backlogMaxAgeMinutes * MINUTE_MS;
  return backlogPolicy === 'discard_stale' ? DEFAULT_STALE_BACKLOG_MINUTES * MINUTE_MS : undefined;
}
