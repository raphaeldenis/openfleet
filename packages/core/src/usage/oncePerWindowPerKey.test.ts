import { describe, expect, it } from 'vitest';
import { OncePerWindowPerKey } from './oncePerWindowPerKey.js';

const ONE_MINUTE_MS = 60_000;

describe('OncePerWindowPerKey', () => {
  it('admits the first request of a key and refuses the following ones inside the window', () => {
    let now = 0;
    const gate = new OncePerWindowPerKey(ONE_MINUTE_MS, () => now);

    const answers = [0, 10_000, 59_999].map((at) => { now = at; return gate.admits('s1'); });

    expect(answers).toEqual([true, false, false]);
  });

  it('admits again once the window has passed since the last admitted request', () => {
    let now = 0;
    const gate = new OncePerWindowPerKey(ONE_MINUTE_MS, () => now);
    gate.admits('s1');

    now = ONE_MINUTE_MS;

    expect(gate.admits('s1')).toBe(true);
  });

  it('keeps one window per key', () => {
    const gate = new OncePerWindowPerKey(ONE_MINUTE_MS, () => 0);
    gate.admits('s1');

    expect(gate.admits('s2')).toBe(true);
  });
});
