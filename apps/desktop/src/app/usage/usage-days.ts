import type { UsageDailyRow } from '../core/usage-daily-parser';

export type UsageRange = 'today' | 'last7Days' | 'last30Days';

export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** The sum of the priced buckets; null when none of them is priced. */
  readonly costUsd: number | null;
}

export interface ModelTotals extends UsageTokens {
  readonly model: string;
}

export interface DayTotals extends UsageTokens {
  readonly dayUtc: string;
  readonly byModel: readonly ModelTotals[];
}

const DAYS_BY_RANGE: Readonly<Record<UsageRange, number>> = { today: 1, last7Days: 7, last30Days: 30 };
const MS_PER_DAY = 86_400_000;
const UTC_DAY_KEY_LENGTH = 'YYYY-MM-DD'.length;
const utcDayOf = (instant: Date): string => instant.toISOString().slice(0, UTC_DAY_KEY_LENGTH);

/** The UTC days a range covers, ending on the day of `now`. */
export function usageRangeOf(range: UsageRange, now: Date): { fromDayUtc: string; toDayUtc: string } {
  const daysBeforeToday = DAYS_BY_RANGE[range] - 1;
  return { fromDayUtc: utcDayOf(new Date(now.getTime() - daysBeforeToday * MS_PER_DAY)), toDayUtc: utcDayOf(now) };
}

function totalsOf(rows: readonly UsageDailyRow[]): UsageTokens {
  const pricedCosts = rows.map((row) => row.costUsd).filter((cost): cost is number => cost !== null);
  const sum = (pick: (row: UsageDailyRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    cacheReadInputTokens: sum((row) => row.cacheReadInputTokens),
    cacheCreationInputTokens: sum((row) => row.cacheCreationInputTokens),
    costUsd: pricedCosts.length === 0 ? null : pricedCosts.reduce((total, cost) => total + cost, 0),
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

/** One entry per UTC day, most recent first, each split by model. */
export function dailyTotalsOf(rows: readonly UsageDailyRow[]): DayTotals[] {
  const days = [...groupBy(rows, (row) => row.dayUtc)].map(([dayUtc, dayRows]) => ({
    dayUtc,
    ...totalsOf(dayRows),
    byModel: [...groupBy(dayRows, (row) => row.model)].map(([model, modelRows]) => ({ model, ...totalsOf(modelRows) })),
  }));
  return days.sort((earlier, later) => later.dayUtc.localeCompare(earlier.dayUtc));
}
