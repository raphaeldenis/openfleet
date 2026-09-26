import { describe, expect, it } from 'vitest';
import { countdownLabel } from './manager-countdown';

describe('countdownLabel', () => {
  it('formats seconds under a minute as 0:ss', () => {
    expect(countdownLabel(40)).toBe('0:40');
  });

  it('formats seconds under an hour as m:ss, zero-padding the seconds', () => {
    expect(countdownLabel(580)).toBe('9:40');
  });

  it('formats a full hour or more as h:mm:ss, zero-padding minutes and seconds', () => {
    expect(countdownLabel(3723)).toBe('1:02:03');
  });

  it('shows 0:00 once the countdown reaches zero, instead of raw seconds', () => {
    expect(countdownLabel(0)).toBe('0:00');
  });

  it('shows a placeholder when there is no countdown to display', () => {
    expect(countdownLabel(null)).toBe('—');
  });
});
