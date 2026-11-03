import { describe, expect, it } from 'vitest';
import { cronScheduleOf, daySatisfies } from './cronExpression.js';
import { TriggerWhenSchema } from './triggers.js';

const parse = (expression: string) => cronScheduleOf(expression);
const sorted = (values: ReadonlySet<number> | undefined) => [...(values ?? [])].sort((a, b) => a - b);

describe('cronScheduleOf', () => {
  it('reads lists, ranges, steps and names in the five fields', () => {
    const schedule = parse('*/20 8-10,14 1,15 JAN,mar MON-FRI');

    expect(sorted(schedule?.minutes)).toEqual([0, 20, 40]);
    expect(sorted(schedule?.hours)).toEqual([8, 9, 10, 14]);
    expect(sorted(schedule?.daysOfMonth)).toEqual([1, 15]);
    expect(sorted(schedule?.months)).toEqual([1, 3]);
    expect(sorted(schedule?.daysOfWeek)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads 7 as Sunday', () => {
    expect(sorted(parse('0 0 * * 5-7')?.daysOfWeek)).toEqual([0, 5, 6]);
  });

  it.each([
    ['a step of zero', '*/0 * * * *'],
    ['a minute out of range', '60 * * * *'],
    ['an hour out of range', '0 24 * * *'],
    ['a reversed range', '0 10-5 * * *'],
    ['six fields', '0 0 0 * * *'],
    ['an unknown name', '0 0 * * FUNDAY'],
    ['a step larger than the field', '*/70 * * * *'],
  ])('refuses %s', (_label, expression) => {
    expect(parse(expression)).toBeUndefined();
  });

  it.each([
    ['the 30th of February', '0 0 30 2 *'],
    ['the 31st of April', '0 0 31 4 *'],
    ['the 31st of April, June and November', '0 0 31 4,6,11 *'],
  ])('refuses %s, which never fires', (_label, expression) => {
    expect(parse(expression)).toBeUndefined();
  });

  it('accepts the 29th of February, which fires every fourth year', () => {
    expect(parse('0 0 29 2 *')).not.toBeUndefined();
  });

  it('accepts the 31st when one month of the list has 31 days', () => {
    expect(parse('0 0 31 2,3 *')).not.toBeUndefined();
  });

  it('accepts a day of month that never exists in the month when a weekday is also restricted, because either day matches', () => {
    expect(parse('0 0 30 2 MON')).not.toBeUndefined();
  });
});

describe('daySatisfies', () => {
  it('requires both day fields when one of them is a wildcard', () => {
    const schedule = parse('0 0 15 * *')!;

    expect(daySatisfies(schedule, { month: 3, dayOfMonth: 15, weekday: 2 })).toBe(true);
    expect(daySatisfies(schedule, { month: 3, dayOfMonth: 16, weekday: 2 })).toBe(false);
  });

  it('accepts either day field when both are restricted', () => {
    const schedule = parse('0 0 15 * MON')!;

    expect(daySatisfies(schedule, { month: 3, dayOfMonth: 15, weekday: 2 })).toBe(true);
    expect(daySatisfies(schedule, { month: 3, dayOfMonth: 16, weekday: 1 })).toBe(true);
    expect(daySatisfies(schedule, { month: 3, dayOfMonth: 16, weekday: 2 })).toBe(false);
  });
});

describe('? in the day fields', () => {
  const tuesdayThe3rd = { month: 11, dayOfMonth: 3, weekday: 2 };

  it('reads ?/2 exactly as */2: the day of month is a wildcard, so both day fields must match', () => {
    const withQuestionMark = parse('0 0 ?/2 * MON')!;
    const withStar = parse('0 0 */2 * MON')!;

    expect(daySatisfies(withStar, tuesdayThe3rd)).toBe(false);
    expect(daySatisfies(withQuestionMark, tuesdayThe3rd)).toBe(false);
    expect(sorted(withQuestionMark.daysOfMonth)).toEqual(sorted(withStar.daysOfMonth));
    expect(withQuestionMark.isDayOfMonthWildcard).toBe(true);
  });

  it('reads ? as * in the day of week', () => {
    expect(parse('0 0 15 * ?')).toEqual(parse('0 0 15 * *'));
  });
});

describe('the cron WHEN schema', () => {
  const cron = (when: Record<string, unknown>) => TriggerWhenSchema.safeParse({ source: 'cron', ...when });

  it('refuses an expression that never fires', () => {
    expect(cron({ expression: '0 0 30 2 *', timezone: 'Europe/Paris' }).success).toBe(false);
  });

  it('defaults the time zone to Europe/Paris and the catch-up to skip', () => {
    const parsed = cron({ expression: '0 9 * * *' });

    expect(parsed.success && parsed.data).toMatchObject({ timezone: 'Europe/Paris', catchUp: 'skip' });
  });

  it('refuses an expression with a field that is not valid', () => {
    expect(cron({ expression: '61 * * * *' }).success).toBe(false);
  });
});
