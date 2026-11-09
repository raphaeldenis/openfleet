import type { TriggerFireReason, TriggerLedgerState } from '@openfleet/shared';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import { evaluateConditions } from '../playbooks/kernel/conditionEvaluator.js';
import { log } from '../logger.js';
import type { FireBreaker } from './fireBreaker.js';
import type { FireLedger, TriggerFire } from './fireLedger.js';
import { policyVerdictOf } from './firePolicy.js';
import { kernelConditionsOf } from './kernelConditions.js';
import { reviewDigestOf } from './triggerService.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

export const MAX_EVENT_JSON_CHARS = 8192;
/** A fire caused by a fire is depth 2; a third link is refused. */
export const MAX_CHAIN_DEPTH = 2;
const MINUTE_MS = 60_000;
/** A discard_stale backlog with no explicit age keeps the fires of the last hour. */
export const DEFAULT_STALE_BACKLOG_MINUTES = 60;
/** A message a trigger sent to a session counts as the cause of the events of that session for this long. */
export const CHAIN_CAUSE_WINDOW_MINUTES = 60;

/** How the effect of a fire ended: it ran, or it did not and says why. */
export type SettledResult = { settlement: 'completed'; runId?: string } | { settlement: 'cancelled'; reason: TriggerFireReason };

/** What an action answers: the end of the effect, or a promise of it when the effect is not instant. A pending fire stays `attempted` until the promise ends. */
export type ActionResult = SettledResult | { settlement: 'pending'; settled: Promise<SettledResult> };

export interface TriggerActions {
  perform(input: { trigger: TriggerRecord; fire: TriggerFire; batchSize: number }): ActionResult;
}

export type SubmitResult =
  | { outcome: 'not_armed' | 'filtered' | 'event_too_large' }
  | { outcome: 'duplicate'; fireId: string }
  | { outcome: 'fired'; fireId: string; ledgerState: TriggerLedgerState };

export interface TriggerEngineDeps {
  triggers: Pick<TriggerRepository, 'get' | 'disarm'>;
  ledger: FireLedger;
  actions: TriggerActions;
  breaker: FireBreaker;
  clock: () => number;
  newId: () => string;
  /** Arms a one-shot timer and returns its cancel function. */
  schedule: (callback: () => void, delayMs: number) => () => void;
  /** Called once when the breaker disarms a trigger. */
  onBreakerOpened: (trigger: TriggerRecord) => void;
  /** Called once for each fire that ends `completed` or `cancelled`. */
  onSettled: (settled: SettledFire) => void;
}

export interface SettledFire {
  triggerId: string;
  fireId: string;
  ledgerState: 'completed' | 'cancelled';
  reason?: TriggerFireReason;
}

/** True when a human armed the trigger as it stands now: the armed digest still matches what would run. */
export const isArmedAsItStands = (trigger: TriggerRecord): boolean =>
  trigger.armedAt !== null && trigger.approvedGraphDigest === reviewDigestOf(trigger);

/** The sessions an event is about: the session itself and its parent. */
const sessionIdsOf = (event: Record<string, unknown>): string[] => {
  const session = (event.session ?? {}) as { id?: unknown; parentId?: unknown };
  return [session.id, session.parentId].filter((id): id is string => typeof id === 'string');
};

/**
 * Turns the events a source reports into fires. A fire is written to the ledger before anything happens for it, so a daemon that stops
 * at any point leaves a row that says how far the fire got. The guarantee is at most once per (trigger, dedup key), never exactly once.
 */
export class TriggerEngine {
  private readonly drainTimers = new Map<string, () => void>();

  constructor(private readonly deps: TriggerEngineDeps) {}

  /** Offers one event of a source: it fires when the trigger is armed, its conditions hold and its dedup key is new. */
  submit(input: { triggerId: string; dedupKey: string; event: Record<string, unknown>; causedByChainDepth?: number }): SubmitResult {
    const { triggers, clock } = this.deps;
    const trigger = triggers.get(input.triggerId);
    if (trigger === undefined || !isArmedAsItStands(trigger)) return { outcome: 'not_armed' };

    const accepted = this.accept({ trigger, dedupKey: input.dedupKey, event: input.event, firedAtMs: clock(), causedByChainDepth: input.causedByChainDepth });
    if (accepted.outcome !== 'accepted') return accepted.outcome === 'duplicate' ? { outcome: 'duplicate', fireId: accepted.fire.id } : { outcome: accepted.outcome };

    const ledgerState = this.process({ trigger, fire: accepted.fire, batchSize: 1 });
    return { outcome: 'fired', fireId: accepted.fire.id, ledgerState };
  }

  /**
   * Offers the events a source found due late, such as a wait that ended while the daemon was stopped. Each fire is dated with the moment its
   * event was due, so its age is the lateness; the offers are then judged together by the backlog policy of the trigger, as the fires left `accepted` are at boot.
   */
  submitBacklog(input: { triggerId: string; offers: { dedupKey: string; event: Record<string, unknown>; dueAtMs: number; causedByChainDepth?: number }[] }): void {
    const trigger = this.deps.triggers.get(input.triggerId);
    if (trigger === undefined || !isArmedAsItStands(trigger)) return;

    const oldestFirst = [...input.offers].sort((first, second) => first.dueAtMs - second.dueAtMs);
    const acceptedFires: TriggerFire[] = [];
    for (const offer of oldestFirst) {
      const accepted = this.accept({ trigger, dedupKey: offer.dedupKey, event: offer.event, firedAtMs: offer.dueAtMs, causedByChainDepth: offer.causedByChainDepth });
      if (accepted.outcome === 'accepted') acceptedFires.push(accepted.fire);
    }
    if (acceptedFires.length > 0) this.replayBacklogOf(trigger, acceptedFires);
  }

  private accept(input: { trigger: TriggerRecord; dedupKey: string; event: Record<string, unknown>; firedAtMs: number; causedByChainDepth?: number | undefined }):
    | { outcome: 'filtered' | 'event_too_large' } | { outcome: 'duplicate' | 'accepted'; fire: TriggerFire } {
    const { ledger, newId } = this.deps;
    const holds = evaluateConditions(kernelConditionsOf(input.trigger.conditions), { event: input.event });
    if (!holds) return { outcome: 'filtered' };

    const eventJson = JSON.stringify(input.event);
    if (eventJson.length > MAX_EVENT_JSON_CHARS) return { outcome: 'event_too_large' };

    const accepted = ledger.accept({
      id: newId(), triggerId: input.trigger.id, dedupKey: input.dedupKey, firedAt: new Date(input.firedAtMs).toISOString(), eventDigest: canonicalDigestOf(input.event), eventJson,
      chainDepth: Math.max(this.chainDepthOf(input.event), (input.causedByChainDepth ?? 0) + 1),
    });
    return { outcome: accepted.wasAccepted ? 'accepted' : 'duplicate', fire: accepted.fire };
  }

  /**
   * Settles what a stopped daemon left behind: a fire it had attempted needs a human's review and is never replayed, and a fire it had only
   * accepted is judged again by its backlog policy for its age, then by the policy of the trigger.
   */
  recover(): void {
    const { ledger, clock } = this.deps;
    const interruptedCount = ledger.markInterruptedForReview(new Date(clock()).toISOString());
    if (interruptedCount > 0) log('warn', `${interruptedCount} trigger fire(s) were interrupted while they ran: they need a review and are not replayed`);
    this.replayAcceptedBacklog();
  }

  /** Cancels the timers of the batches that wait; the fires stay accepted for the next boot. */
  stop(): void {
    for (const cancel of this.drainTimers.values()) cancel();
    this.drainTimers.clear();
  }

  private chainDepthOf(event: Record<string, unknown>): number {
    const { ledger, clock } = this.deps;
    const sinceIso = new Date(clock() - CHAIN_CAUSE_WINDOW_MINUTES * MINUTE_MS).toISOString();
    return ledger.deepestChainMessagedSince({ sessionIds: sessionIdsOf(event), sinceIso }) + 1;
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
    const now = this.deps.clock();
    if (!isArmedAsItStands(trigger)) return void acceptedFires.forEach((fire) => this.cancel(fire, 'disarmed'));

    const maxAgeMs = backlogMaxAgeMsOf(trigger);
    const isFreshEnough = (fire: TriggerFire) => maxAgeMs === undefined || now - Date.parse(fire.firedAt) <= maxAgeMs;
    const fresh = acceptedFires.filter(isFreshEnough);
    acceptedFires.filter((fire) => !isFreshEnough(fire)).forEach((fire) => this.cancel(fire, 'stale'));

    const toReplay = trigger.policy.backlogPolicy === 'fire_latest_only' ? fresh.slice(-1) : fresh;
    fresh.filter((fire) => !toReplay.includes(fire)).forEach((fire) => this.cancel(fire, 'superseded'));
    for (const fire of toReplay) this.process({ trigger, fire, batchSize: 1 });
  }

  private cancel(fire: TriggerFire, reason: TriggerFireReason): void {
    this.deps.ledger.markCancelled({ id: fire.id, settledAt: new Date(this.deps.clock()).toISOString(), reason });
    this.deps.onSettled({ triggerId: fire.triggerId, fireId: fire.id, ledgerState: 'cancelled', reason });
  }

  /** Judges an accepted fire against the chain depth, the policy and the breaker; runs it, holds it for its batch, or cancels it. */
  private process({ trigger, fire, batchSize }: { trigger: TriggerRecord; fire: TriggerFire; batchSize: number }): TriggerLedgerState {
    const { ledger, clock, breaker } = this.deps;
    const isTooDeep = fire.chainDepth > MAX_CHAIN_DEPTH;
    if (isTooDeep) return this.cancelled(fire, 'chain_depth');

    const policy = policyVerdictOf({ trigger, fire, ledger, now: clock() });
    if (policy.verdict === 'cancel') return this.cancelled(fire, policy.reason);
    if (policy.verdict === 'hold') {
      this.scheduleDrain(trigger.id, policy.waitMs);
      return 'accepted';
    }

    if (!breaker.tryStart()) return this.openBreaker(trigger, fire);
    return this.run({ trigger, fire, batchSize });
  }

  private cancelled(fire: TriggerFire, reason: TriggerFireReason): TriggerLedgerState {
    this.cancel(fire, reason);
    return 'cancelled';
  }

  private openBreaker(trigger: TriggerRecord, fire: TriggerFire): TriggerLedgerState {
    this.deps.triggers.disarm(trigger.id);
    this.cancel(fire, 'breaker_open');
    this.deps.onBreakerOpened(trigger);
    return 'cancelled';
  }

  private scheduleDrain(triggerId: string, waitMs: number): void {
    if (this.drainTimers.has(triggerId)) return;
    const cancel = this.deps.schedule(() => {
      this.drainTimers.delete(triggerId);
      this.drainBatchOf(triggerId);
    }, waitMs);
    this.drainTimers.set(triggerId, cancel);
  }

  /** Fires the newest of the held events as one batch and cancels the older ones as batched. */
  private drainBatchOf(triggerId: string): void {
    const trigger = this.deps.triggers.get(triggerId);
    const held = this.deps.ledger.listAcceptedOf(triggerId);
    const newest = held.at(-1);
    if (newest === undefined) return;
    if (trigger === undefined || !isArmedAsItStands(trigger)) return void held.forEach((fire) => this.cancel(fire, 'disarmed'));
    held.slice(0, -1).forEach((fire) => this.cancel(fire, 'batched'));
    this.process({ trigger, fire: newest, batchSize: held.length });
  }

  /** Writes `attempted`, runs the effect, then writes how it ended. */
  private run({ trigger, fire, batchSize }: { trigger: TriggerRecord; fire: TriggerFire; batchSize: number }): TriggerLedgerState {
    const { ledger, clock } = this.deps;
    const stillOwnsTheFire = ledger.markAttempted({ id: fire.id, effectStartedAt: new Date(clock()).toISOString() });
    if (!stillOwnsTheFire) return ledger.get(fire.id)?.ledgerState ?? 'cancelled';

    const result = this.performSafely({ trigger, fire, batchSize });
    if (result.settlement === 'pending') return this.settleWhenTheEffectEnds(fire, result.settled);
    return this.settle(fire, result);
  }

  /** The fire stays `attempted` until the effect ends; a daemon that stops meanwhile leaves it for the review at the next boot, never replayed. */
  private settleWhenTheEffectEnds(fire: TriggerFire, effect: Promise<SettledResult>): TriggerLedgerState {
    const failed: SettledResult = { settlement: 'cancelled', reason: 'action_failed' };
    effect
      .catch((error: unknown) => { log('error', `the action of trigger ${fire.triggerId} failed for fire ${fire.id}`, error); return failed; })
      .then((result) => this.settle(fire, result))
      .catch((error: unknown) => log('error', 'the outcome of a pending trigger fire could not be written to the ledger', error));
    return 'attempted';
  }

  private settle(fire: TriggerFire, result: SettledResult): TriggerLedgerState {
    const { ledger, clock } = this.deps;
    const settledAt = new Date(clock()).toISOString();
    if (result.settlement === 'completed') {
      ledger.markCompleted({ id: fire.id, settledAt, runId: result.runId });
      this.deps.onSettled({ triggerId: fire.triggerId, fireId: fire.id, ledgerState: 'completed' });
      return 'completed';
    }
    ledger.markCancelled({ id: fire.id, settledAt, reason: result.reason });
    this.deps.onSettled({ triggerId: fire.triggerId, fireId: fire.id, ledgerState: 'cancelled', reason: result.reason });
    return 'cancelled';
  }

  private performSafely(input: { trigger: TriggerRecord; fire: TriggerFire; batchSize: number }): ActionResult {
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
