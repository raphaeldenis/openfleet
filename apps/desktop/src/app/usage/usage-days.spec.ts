import { describe, expect, it } from 'vitest';
import type { UsageDailyRow } from '../core/usage-daily-parser';
import { dailyTotalsOf, usageRangeOf } from './usage-days';

const bucket = (overrides: Partial<UsageDailyRow> = {}): UsageDailyRow => ({
  dayUtc: '2026-10-30',
  model: 'opus',
  sessionId: 's1',
  billingCode: 'general',
  biller: 'api',
  costStatus: 'reported',
  messageCount: 1,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadInputTokens: 1_000,
  cacheCreationInputTokens: 50,
  costUsd: 0.5,
  ...overrides,
});

describe('dailyTotalsOf', () => {
  it('sums the buckets of one day across sessions and models', () => {
    const rows = [bucket(), bucket({ sessionId: 's2', model: 'sonnet', inputTokens: 200, outputTokens: 20, costUsd: 0.25 })];

    const [day] = dailyTotalsOf(rows);

    expect(day).toMatchObject({ dayUtc: '2026-10-30', inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 100, costUsd: 0.75 });
  });

  it('lists the most recent day first', () => {
    const rows = [bucket({ dayUtc: '2026-10-28' }), bucket({ dayUtc: '2026-10-30' }), bucket({ dayUtc: '2026-10-29' })];

    expect(dailyTotalsOf(rows).map((day) => day.dayUtc)).toEqual(['2026-10-30', '2026-10-29', '2026-10-28']);
  });

  it('splits a day by model, merging the sessions of a model', () => {
    const rows = [bucket({ model: 'opus' }), bucket({ model: 'opus', sessionId: 's2', inputTokens: 5 }), bucket({ model: 'haiku', inputTokens: 7 })];

    const [day] = dailyTotalsOf(rows);

    expect(day!.byModel.map((model) => [model.model, model.inputTokens])).toEqual([['opus', 105], ['haiku', 7]]);
  });

  it('counts only the priced buckets in the cost and leaves it unknown when none is priced', () => {
    const mixed = dailyTotalsOf([bucket({ costUsd: 0.5 }), bucket({ model: 'haiku', costStatus: 'unpriced', costUsd: null })]);
    const unpriced = dailyTotalsOf([bucket({ costStatus: 'unpriced', costUsd: null })]);

    expect(mixed[0]!.costUsd).toBe(0.5);
    expect(unpriced[0]!.costUsd).toBeNull();
  });

  it('returns no day for no bucket', () => {
    expect(dailyTotalsOf([])).toEqual([]);
  });
});

describe('usageRangeOf', () => {
  const now = new Date('2026-10-31T23:30:00Z');

  it.each([
    ['today', { fromDayUtc: '2026-10-31', toDayUtc: '2026-10-31' }],
    ['last7Days', { fromDayUtc: '2026-10-25', toDayUtc: '2026-10-31' }],
    ['last30Days', { fromDayUtc: '2026-10-02', toDayUtc: '2026-10-31' }],
  ] as const)('spans %s in UTC days ending today', (range, expected) => {
    expect(usageRangeOf(range, now)).toEqual(expected);
  });
});
