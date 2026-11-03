import { cronScheduleOf, type TriggerWhen } from '@openfleet/shared';
import { log } from '../logger.js';
import { cronCalendarOf, localFieldsAt } from './cronCalendar.js';
import { CRON_CURSOR_KIND, type TriggerCursors } from './triggerCursors.js';
import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const MINUTE_MS = 60_000;
/** A timer never waits longer than this, so a long wait is re-read against the clock and never overflows the timer. */
export const MAX_WAIT_MS = 60 * MINUTE_MS;
/** A slot found this long after its instant is a missed slot, judged by `catchUp`; a nearer one is a live fire. */
export const ON_TIME_WITHIN_MS = 2 * MINUTE_MS;
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

export interface CronSourceDeps {
  triggers: Pick<TriggerRepository, 'get' | 'listArmed'>;
  cursors: Pick<TriggerCursors, 'read' | 'save'>;
  engine: Pick<TriggerEngine, 'submitBacklog'>;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Offers the engine the slots of the cron triggers. There is one timer per armed trigger, set to its next slot (at most an hour away); a wake reads every slot between
 * the cursor and the clock. A slot found within two minutes of its instant is live. When older slots are found, the daemon was stopped or asleep: `catchUp` chooses which
 * of them are offered (none, the latest, the newest five), and the backlog policy of the trigger then judges their age. The cursor moves to the newest slot after the offer,
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
      this.setTimer(trigger);
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
    const cursor = this.cursorOf(trigger);
    if (cursor === undefined) return this.startFromNow(trigger);

    const calendar = this.calendarOf(trigger);
    if (calendar === undefined) return;
    const now = this.deps.clock();
    const throughMs = Date.parse(cursor.through);
    const dueNewestFirst = calendar.newestBetween({ afterMs: throughMs, atMs: now, limit: RUN_ALL_CAP });
    const newestDue = dueNewestFirst[0];
    if (newestDue !== undefined) {
      this.deps.engine.submitBacklog({ triggerId: trigger.id, offers: this.offersOf(trigger, dueNewestFirst, now) });
      this.deps.cursors.save(trigger.id, { kind: CRON_CURSOR_KIND, through: new Date(newestDue).toISOString() } satisfies CronCursor);
    }
    this.setTimer(trigger);
  }

  /** The slots to offer, oldest first: all of them when none is late, else the ones `catchUp` keeps. */
  private offersOf(trigger: CronTrigger, dueNewestFirst: number[], now: number): Offer[] {
    const { catchUp, timezone } = trigger.when;
    const isLive = (slotMs: number) => now - slotMs <= ON_TIME_WITHIN_MS;
    const hasMissedSlots = !dueNewestFirst.every(isLive);
    const kept = !hasMissedSlots ? dueNewestFirst
      : catchUp === 'run_once' ? dueNewestFirst.slice(0, 1)
      : catchUp === 'run_all' ? dueNewestFirst.slice(0, RUN_ALL_CAP)
      : dueNewestFirst.filter(isLive);
    return kept.reverse().map((slotMs) => ({ dedupKey: dedupKeyOf(slotMs), event: eventOf(timezone, slotMs), dueAtMs: slotMs }));
  }

  /** One timer per trigger: set for the next slot, or an hour away when the slot is farther. */
  private setTimer(trigger: CronTrigger): void {
    this.cancelTimer(trigger.id);
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
