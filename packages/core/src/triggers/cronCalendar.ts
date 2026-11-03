import { daySatisfies, type CivilDay, type CronSchedule } from '@openfleet/shared';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HOURS_IN_A_DAY = 24;
/** The farthest a search goes: eight years cover the leap-day expressions with room to spare. */
export const MAX_DAYS_SEARCHED = 366 * 8;

interface CivilFields { year: number; month: number; dayOfMonth: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterOf = (timeZone: string): Intl.DateTimeFormat => {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;
  const created = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  formatters.set(timeZone, created);
  return created;
};

/** The minutes the zone is ahead of UTC at this instant. */
function offsetMinutesAt(timeZone: string, instantMs: number): number {
  const parts = Object.fromEntries(formatterOf(timeZone).formatToParts(new Date(instantMs)).map((part) => [part.type, Number(part.value)]));
  const wallClockAsUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((wallClockAsUtc - Math.floor(instantMs / 1000) * 1000) / MINUTE_MS);
}

const civilUtcMsOf = (civil: CivilFields): number => Date.UTC(civil.year, civil.month - 1, civil.dayOfMonth, civil.hour, civil.minute);

/** The local wall clock at an instant, with the day of the week. */
export function localFieldsAt(timeZone: string, instantMs: number): CivilFields & { weekday: number } {
  const wallClock = new Date(instantMs + offsetMinutesAt(timeZone, instantMs) * MINUTE_MS);
  return {
    year: wallClock.getUTCFullYear(), month: wallClock.getUTCMonth() + 1, dayOfMonth: wallClock.getUTCDate(),
    hour: wallClock.getUTCHours(), minute: wallClock.getUTCMinutes(), weekday: wallClock.getUTCDay(),
  };
}

/** The instants at which the wall clock of the zone reads this time: none in a gap, two in a repeated hour, one otherwise. */
function instantsReading(timeZone: string, civil: CivilFields): number[] {
  const civilUtcMs = civilUtcMsOf(civil);
  const offsetsAround = new Set([offsetMinutesAt(timeZone, civilUtcMs - DAY_MS), offsetMinutesAt(timeZone, civilUtcMs + DAY_MS)]);
  const candidates = [...offsetsAround].map((offset) => civilUtcMs - offset * MINUTE_MS);
  return candidates.filter((instant) => civilUtcMsOf(localFieldsAt(timeZone, instant)) === civilUtcMs).sort((first, second) => first - second);
}

/** The first instant after a gap: the moment the zone jumps over the wall clock time that does not exist. */
function endOfTheGapSwallowing(timeZone: string, civil: CivilFields): number {
  const civilUtcMs = civilUtcMsOf(civil);
  const offsetBefore = offsetMinutesAt(timeZone, civilUtcMs - DAY_MS);
  const offsetAfter = offsetMinutesAt(timeZone, civilUtcMs + DAY_MS);
  let stillBefore = Math.floor((civilUtcMs - offsetAfter * MINUTE_MS) / MINUTE_MS);
  let alreadyAfter = Math.ceil((civilUtcMs - offsetBefore * MINUTE_MS) / MINUTE_MS);
  while (alreadyAfter - stillBefore > 1) {
    const middle = Math.floor((stillBefore + alreadyAfter) / 2);
    if (offsetMinutesAt(timeZone, middle * MINUTE_MS) === offsetBefore) stillBefore = middle;
    else alreadyAfter = middle;
  }
  return alreadyAfter * MINUTE_MS;
}

/**
 * The slots of a cron schedule in a time zone. A slot is an instant in epoch milliseconds.
 * In a repeated hour a fixed-hour expression fires at the first reading only, while an expression that runs in every hour fires at each real one.
 * A wall clock time that does not exist fires once, at the first instant after the gap.
 */
export function cronCalendarOf(schedule: CronSchedule, timeZone: string) {
  const firesEveryHour = schedule.hours.size === HOURS_IN_A_DAY;
  const sortedHours = [...schedule.hours].sort((first, second) => first - second);
  const sortedMinutes = [...schedule.minutes].sort((first, second) => first - second);

  const slotsOfDay = (day: CivilDay & { year: number }): number[] => {
    if (!daySatisfies(schedule, day)) return [];
    const slots = new Set<number>();
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const civil = { year: day.year, month: day.month, dayOfMonth: day.dayOfMonth, hour, minute };
        const readings = instantsReading(timeZone, civil);
        if (readings.length === 0) slots.add(endOfTheGapSwallowing(timeZone, civil));
        else (firesEveryHour ? readings : readings.slice(0, 1)).forEach((instant) => slots.add(instant));
      }
    }
    return [...slots].sort((first, second) => first - second);
  };

  const dayAt = (referenceDayUtcMs: number, daysFromReference: number): CivilDay & { year: number } => {
    const date = new Date(referenceDayUtcMs + daysFromReference * DAY_MS);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, dayOfMonth: date.getUTCDate(), weekday: date.getUTCDay() };
  };
  const localDayStartUtcMs = (instantMs: number): number => {
    const local = localFieldsAt(timeZone, instantMs);
    return Date.UTC(local.year, local.month - 1, local.dayOfMonth);
  };

  return {
    /** The first slot strictly after the instant; undefined when none comes within eight years. */
    nextAfter(afterMs: number): number | undefined {
      const referenceDay = localDayStartUtcMs(afterMs);
      for (let offset = -1; offset <= MAX_DAYS_SEARCHED; offset += 1) {
        const next = slotsOfDay(dayAt(referenceDay, offset)).find((slot) => slot > afterMs);
        if (next !== undefined) return next;
      }
      return undefined;
    },
    /** The newest slots in `(afterMs, atMs]`, newest first, at most `limit`. */
    newestBetween(input: { afterMs: number; atMs: number; limit: number }): number[] {
      const found: number[] = [];
      const referenceDay = localDayStartUtcMs(input.atMs);
      const oldestDay = localDayStartUtcMs(input.afterMs);
      const daysBack = Math.min(MAX_DAYS_SEARCHED, Math.round((referenceDay - oldestDay) / DAY_MS) + 1);
      for (let offset = 1; offset >= -daysBack && found.length < input.limit; offset -= 1) {
        const inRange = slotsOfDay(dayAt(referenceDay, offset)).filter((slot) => slot > input.afterMs && slot <= input.atMs);
        found.push(...inRange.reverse());
      }
      return found.slice(0, input.limit);
    },
  };
}
