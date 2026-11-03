import { cronScheduleOf, type TriggerWhen } from '@openfleet/shared';
import { log } from '../logger.js';
import { cronCalendarOf, localFieldsAt } from './cronCalendar.js';
import { CRON_CURSOR_KIND, type TriggerCursors } from './triggerCursors.js';
import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const MINUTE_MS = 60_000;
/** A timer never waits longer than this, so a long wait is re-read against the clock and never overflows the timer. */
export const MAX_WAIT_MS = 60 * MINUTE_MS;
/** A slot found this long after its instant or less is live and always offered; an older one is missed and judged by `catchUp`. */
export const ON_TIME_WITHIN_MS = 2 * MINUTE_MS;
/** The most slots an every-minute expression has in the live window. */
const MAX_LIVE_SLOTS = ON_TIME_WITHIN_MS / MINUTE_MS + 1;
/** `run_all` offers at most the newest of this many missed slots. */
export const RUN_ALL_CAP = 5;

type CronWhen = Extract<TriggerWhen, { source: 'cron' }>;
type CronTrigger = TriggerRecord & { when: CronWhen };
const isCronTrigger = (trigger: TriggerRecord): trigger is CronTrigger => trigger.when.source === 'cron';

/** What a cron trigger remembers: the instant up to which every slot is dealt with, the last slot it handled or the moment it was armed. */
interface CronCursor { kind: typeof CRON_CURSOR_KIND; through: string }
const isCronCursor = (value: unknown): value is CronCursor => {
  const candidate = value as Partial<CronCursor> | null;
  return candidate?.kind === CRON_CURSOR_KIND && typeof candidate.through === 'string' && Number.isFinite(Date.parse(candidate.through));
};

interface Offer { dedupKey: string; event: Record<string, unknown>; dueAtMs: number }

const dedupKeyOf = (slotMs: number): string => `cron:${new Date(slotMs).toISOString()}`;

function eventOf(timeZone: string, slotMs: number): Record<string, unknown> {
  const local = localFieldsAt(timeZone, slotMs);
  const twoDigits = (value: number) => String(value).padStart(2, '0');
  const localDate = `${local.year}-${twoDigits(local.month)}-${twoDigits(local.dayOfMonth)}`;
  return { slot: { at: new Date(slotMs).toISOString(), localDate, localTime: `${twoDigits(local.hour)}:${twoDigits(local.minute)}` } };
}

const offerOf = (timeZone: string, slotMs: number): Offer => ({ dedupKey: dedupKeyOf(slotMs), event: eventOf(timeZone, slotMs), dueAtMs: slotMs });

const noMissedSlot = (_missedNewestFirst: number[]): number[] => [];
const newestMissedSlot = (missedNewestFirst: number[]): number[] => missedNewestFirst.slice(0, 1);
const newestMissedSlots = (missedNewestFirst: number[]): number[] => missedNewestFirst.slice(0, RUN_ALL_CAP);

/** The missed slots each `catchUp` keeps; the live slots do not go through it. */
const MISSED_SLOTS_KEPT_BY: Readonly<Record<CronWhen['catchUp'], (missedNewestFirst: number[]) => number[]>> = {
  skip: noMissedSlot, run_once: newestMissedSlot, run_all: newestMissedSlots,
};

export interface CronSourceDeps {
  triggers: Pick<TriggerRepository, 'get' | 'listArmed'>;
  cursors: Pick<TriggerCursors, 'read' | 'save'>;
  engine: Pick<TriggerEngine, 'submitBacklog'>;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Offers the engine the slots of the cron triggers. There is one timer per armed trigger, set to its next slot (at most an hour away); a wake reads every slot between
 * the cursor and the clock. A slot found within two minutes of its instant is live and always offered. Older slots are missed, the daemon was stopped or asleep: `catchUp` chooses which
 * of them are offered (none, the newest, the newest five), and the backlog policy of the trigger then judges their age. A trigger with no cursor starts from the moment it was armed.
 * The cursor moves to the newest slot after the offer,
 * so a daemon that stops between the two offers the slots again and the ledger absorbs them (dedup key `cron:<slot in UTC>`).
 */
export class CronSource {
  private readonly timers = new Map<string, () => void>();

  constructor(private readonly deps: CronSourceDeps) {}

  /** Catches up each armed cron trigger on what came due while the daemon was stopped, then sets its timer. */
  start(): void {
    for (const trigger of this.armedCronTriggers()) this.guarded(() => this.wake(trigger));
  }

  stop(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /** Puts the cursor of a trigger that was just armed at the present (never behind where it was) and sets its timer: the slots of the time it was disarmed are not offered. */
  startFromNow(trigger: TriggerRecord): void {
    if (!isCronTrigger(trigger)) return;
    this.guarded(() => {
      const previous = this.cursorOf(trigger);
      const through = Math.max(previous === undefined ? 0 : Date.parse(previous.through), this.deps.clock());
      this.deps.cursors.save(trigger.id, { kind: CRON_CURSOR_KIND, through: new Date(through).toISOString() } satisfies CronCursor);
      this.setTimer(trigger.id);
    });
  }

  /** Cancels the timer of a trigger that is deleted, disarmed or no longer a cron trigger. */
  sync(triggerId: string): void {
    const trigger = this.armedCronTriggers().find((candidate) => candidate.id === triggerId);
    if (trigger === undefined) this.cancelTimer(triggerId);
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      log('error', 'the cron source failed on a trigger', error);
    }
  }

  private armedCronTriggers(): CronTrigger[] {
    return this.deps.triggers.listArmed().filter(isCronTrigger);
  }

  private cancelTimer(triggerId: string): void {
    this.timers.get(triggerId)?.();
    this.timers.delete(triggerId);
  }

  private cursorOf(trigger: TriggerRecord): CronCursor | undefined {
    const stored = this.deps.cursors.read(trigger.id);
    return isCronCursor(stored) ? stored : undefined;
  }

  private calendarOf(trigger: CronTrigger) {
    const schedule = cronScheduleOf(trigger.when.expression);
    return schedule === undefined ? undefined : cronCalendarOf(schedule, trigger.when.timezone);
  }

  private wake(trigger: CronTrigger): void {
    this.cancelTimer(trigger.id);
    const cursor = this.cursorOf(trigger) ?? this.cursorAtArmingOf(trigger);
    if (cursor === undefined) return this.startFromNow(trigger);

    const calendar = this.calendarOf(trigger);
    if (calendar === undefined) return;
    const now = this.deps.clock();
    const throughMs = Date.parse(cursor.through);
    const firstLiveMs = now - ON_TIME_WITHIN_MS;
    const liveNewestFirst = calendar.newestBetween({ afterMs: Math.max(throughMs, firstLiveMs - 1), atMs: now, limit: MAX_LIVE_SLOTS });
    const missedNewestFirst = calendar.newestBetween({ afterMs: throughMs, atMs: firstLiveMs - 1, limit: RUN_ALL_CAP });
    const newestDue = liveNewestFirst[0] ?? missedNewestFirst[0];
    if (newestDue !== undefined) {
      const keptMissed = MISSED_SLOTS_KEPT_BY[trigger.when.catchUp](missedNewestFirst);
      const slotsToOffer = [...liveNewestFirst, ...keptMissed].sort((first, second) => first - second);
      this.deps.engine.submitBacklog({ triggerId: trigger.id, offers: slotsToOffer.map((slotMs) => offerOf(trigger.when.timezone, slotMs)) });
      this.deps.cursors.save(trigger.id, { kind: CRON_CURSOR_KIND, through: new Date(newestDue).toISOString() } satisfies CronCursor);
    }
    this.setTimer(trigger.id);
  }

  /** The cursor of a trigger armed without one (before the cursors existed): everything since the moment it was armed is still to deal with. */
  private cursorAtArmingOf(trigger: CronTrigger): CronCursor | undefined {
    const isArmingDated = trigger.armedAt !== null && Number.isFinite(Date.parse(trigger.armedAt));
    return isArmingDated ? { kind: CRON_CURSOR_KIND, through: new Date(Date.parse(trigger.armedAt!)).toISOString() } : undefined;
  }

  /** One timer per trigger: set for the next slot, or an hour away when the slot is farther. The arming is read again, since the offers just made may have disarmed the trigger. */
  private setTimer(triggerId: string): void {
    this.cancelTimer(triggerId);
    const trigger = this.armedCronTriggers().find((candidate) => candidate.id === triggerId);
    if (trigger === undefined) return;
    const calendar = this.calendarOf(trigger);
    const now = this.deps.clock();
    const nextSlot = calendar?.nextAfter(now);
    if (nextSlot === undefined) return;
    const delayMs = Math.min(Math.max(nextSlot - now, 1), MAX_WAIT_MS);
    const cancel = this.deps.schedule(() => {
      this.timers.delete(trigger.id);
      const current = this.armedCronTriggers().find((candidate) => candidate.id === trigger.id);
      if (current !== undefined) this.guarded(() => this.wake(current));
    }, delayMs);
    this.timers.set(trigger.id, cancel);
  }
}
