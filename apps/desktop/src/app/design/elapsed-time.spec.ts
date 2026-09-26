import { describe, expect, it } from 'vitest';
import { elapsedLabel, elapsedSecondsSince } from './elapsed-time';

describe('elapsedSecondsSince', () => {
  it('counts up from a past timestamp to now', () => {
    expect(elapsedSecondsSince('2026-01-01T00:00:00.000Z', new Date('2026-01-01T00:00:40.000Z').getTime())).toBe(40);
  });

  it('never goes negative when the clock is briefly behind the given timestamp', () => {
    expect(elapsedSecondsSince('2026-01-01T00:00:10.000Z', new Date('2026-01-01T00:00:00.000Z').getTime())).toBe(0);
  });

  it('returns null for an unparseable timestamp', () => {
    expect(elapsedSecondsSince('not-a-date', Date.now())).toBeNull();
  });
});

describe('elapsedLabel', () => {
  it('formats seconds under a minute as 0:ss', () => {
    expect(elapsedLabel(40)).toBe('0:40');
  });

  it('formats seconds under an hour as m:ss, zero-padding the seconds', () => {
    expect(elapsedLabel(580)).toBe('9:40');
  });

  it('formats a full hour or more as h:mm:ss, zero-padding minutes and seconds', () => {
    expect(elapsedLabel(3723)).toBe('1:02:03');
  });

  it('returns nothing to display when there is no elapsed time to show', () => {
    expect(elapsedLabel(null)).toBeNull();
  });
});
