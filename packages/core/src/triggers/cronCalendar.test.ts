import { cronScheduleOf } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { cronCalendarOf, localFieldsAt } from './cronCalendar.js';

const PARIS = 'Europe/Paris';
const calendarOf = (expression: string, timeZone = PARIS) => cronCalendarOf(cronScheduleOf(expression)!, timeZone);
const at = (iso: string) => Date.parse(iso);
const isoOf = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe('a plain day', () => {
  it('finds the next slot in the zone, not in UTC', () => {
    const next = calendarOf('0 9 * * *').nextAfter(at('2026-06-10T00:00:00Z'));

    expect(isoOf(next)).toBe('2026-06-10T07:00:00.000Z');
  });

  it('does not return the instant it starts from', () => {
    const next = calendarOf('0 9 * * *').nextAfter(at('2026-06-10T07:00:00Z'));

    expect(isoOf(next)).toBe('2026-06-11T07:00:00.000Z');
  });

  it('reads the zone given, so New York is five or four hours behind Paris', () => {
    const next = calendarOf('0 9 * * *', 'America/New_York').nextAfter(at('2026-01-10T00:00:00Z'));

    expect(isoOf(next)).toBe('2026-01-10T14:00:00.000Z');
  });
});

describe('the clock goes back on 2026-10-25 in Europe/Paris (03:00 CEST becomes 02:00 CET at 01:00Z)', () => {
  it('fires a fixed-hour expression once, at the first reading of the repeated hour', () => {
    const slots = calendarOf('30 2 * * *').newestBetween({ afterMs: at('2026-10-24T23:00:00Z'), atMs: at('2026-10-25T23:00:00Z'), limit: 10 });

    expect(slots.map(isoOf)).toEqual(['2026-10-25T00:30:00.000Z']);
  });

  it('fires an every-hour expression at each real occurrence of the repeated hour', () => {
    const slots = calendarOf('0 * * * *').newestBetween({ afterMs: at('2026-10-24T23:30:00Z'), atMs: at('2026-10-25T02:30:00Z'), limit: 10 });

    expect(slots.map(isoOf).reverse()).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z']);
  });
});

describe('the clock jumps on 2026-03-29 in Europe/Paris (02:00 CET becomes 03:00 CEST at 01:00Z)', () => {
  it('fires an expression that falls in the missing hour once, at 03:00 local', () => {
    const next = calendarOf('30 2 * * *').nextAfter(at('2026-03-28T12:00:00Z'));

    expect(isoOf(next)).toBe('2026-03-29T01:00:00.000Z');
    expect(localFieldsAt(PARIS, next!)).toMatchObject({ hour: 3, minute: 0 });
  });

  it('gives all the minutes of the missing hour the same instant, so they are one slot', () => {
    const slots = calendarOf('*/15 2 * * *').newestBetween({ afterMs: at('2026-03-28T12:00:00Z'), atMs: at('2026-03-29T12:00:00Z'), limit: 10 });

    expect(slots.map(isoOf)).toEqual(['2026-03-29T01:00:00.000Z']);
  });

  it('does not fire twice at 03:00 when the expression also names 03:00', () => {
    const slots = calendarOf('0 2,3 * * *').newestBetween({ afterMs: at('2026-03-28T12:00:00Z'), atMs: at('2026-03-29T12:00:00Z'), limit: 10 });

    expect(slots.map(isoOf)).toEqual(['2026-03-29T01:00:00.000Z']);
  });

  it('fires the day after at the usual hour', () => {
    const next = calendarOf('30 2 * * *').nextAfter(at('2026-03-29T01:00:00Z'));

    expect(isoOf(next)).toBe('2026-03-30T00:30:00.000Z');
  });
});

describe('zones whose offset is not a whole number of hours', () => {
  it('Asia/Kathmandu is 5:45 ahead of UTC', () => {
    const next = calendarOf('0 9 * * *', 'Asia/Kathmandu').nextAfter(at('2026-06-10T00:00:00Z'));

    expect(isoOf(next)).toBe('2026-06-10T03:15:00.000Z');
  });

  it('Australia/Lord_Howe fires a fixed time once when its clock goes back half an hour (2026-04-05, 02:00 +11 becomes 01:30 +10:30)', () => {
    const slots = calendarOf('45 1 * * *', 'Australia/Lord_Howe').newestBetween({ afterMs: at('2026-04-04T00:00:00Z'), atMs: at('2026-04-05T12:00:00Z'), limit: 10 });

    expect(slots.map(isoOf)).toEqual(['2026-04-04T14:45:00.000Z']);
  });

  it('Australia/Lord_Howe fires at each real occurrence of an every-minute expression in the repeated half hour', () => {
    const slots = calendarOf('* * * * *', 'Australia/Lord_Howe').newestBetween({ afterMs: at('2026-04-04T14:44:00Z'), atMs: at('2026-04-04T15:44:00Z'), limit: 200 });

    expect(slots).toHaveLength(60);
  });

  it('Australia/Lord_Howe fires once at the end of the half-hour gap (2026-10-04, 02:00 +10:30 becomes 02:30 +11)', () => {
    const next = calendarOf('15 2 * * *', 'Australia/Lord_Howe').nextAfter(at('2026-10-03T12:00:00Z'));

    expect(isoOf(next)).toBe('2026-10-03T15:30:00.000Z');
  });
});

describe('searching backward and far ahead', () => {
  it('returns the newest slots first, at most the limit', () => {
    const slots = calendarOf('0 * * * *').newestBetween({ afterMs: at('2026-06-10T00:00:00Z'), atMs: at('2026-06-10T12:00:00Z'), limit: 3 });

    expect(slots.map(isoOf)).toEqual(['2026-06-10T12:00:00.000Z', '2026-06-10T11:00:00.000Z', '2026-06-10T10:00:00.000Z']);
  });

  it('excludes the lower bound and includes the upper one', () => {
    const slots = calendarOf('0 * * * *').newestBetween({ afterMs: at('2026-06-10T10:00:00Z'), atMs: at('2026-06-10T11:00:00Z'), limit: 5 });

    expect(slots.map(isoOf)).toEqual(['2026-06-10T11:00:00.000Z']);
  });

  it('finds the next 29th of February from a common year', () => {
    const next = calendarOf('0 0 29 2 *').nextAfter(at('2026-03-01T00:00:00Z'));

    expect(isoOf(next)).toBe('2028-02-28T23:00:00.000Z');
  });
});
