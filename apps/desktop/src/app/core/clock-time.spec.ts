import { describe, expect, it } from 'vitest';
import { clockTimeOf } from './clock-time';

describe('clockTimeOf', () => {
  it('writes a readable instant as two-digit hours and minutes', () => {
    const localInstant = new Date(2026, 9, 5, 9, 7, 30).toISOString();

    expect(clockTimeOf(localInstant)).toMatch(/^09[:.]07$/);
  });

  it('gives an empty string for an unreadable instant', () => {
    expect(clockTimeOf('not a date')).toBe('');
  });
});
