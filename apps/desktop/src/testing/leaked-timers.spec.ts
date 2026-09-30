import { describe, expect, it } from 'vitest';
import { pendingRealTimerCount } from './leaked-timers';

describe('a real timer left pending by a test', () => {
  it('is set and never cleared by the test that leaks it', () => {
    setTimeout(() => undefined, 60_000);
    setInterval(() => undefined, 60_000);

    expect(pendingRealTimerCount()).toBe(2);
  });

  it('does not survive into the next test', () => {
    expect(pendingRealTimerCount()).toBe(0);
  });
});
