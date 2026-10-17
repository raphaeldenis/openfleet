import { describe, expect, it } from 'vitest';
import { ShipVerdictSchema } from './shipVerdict.js';

const SHA = 'a'.repeat(40);

describe('ShipVerdictSchema', () => {
  it('accepts a go with no reason', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'go', reasons: [], sha: SHA }).success).toBe(true);
  });

  it('accepts a no-go that names one to five reasons', () => {
    const fiveReasons = ['a', 'b', 'c', 'd', 'e'];

    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: ['migration is not reversible'], sha: SHA }).success).toBe(true);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: fiveReasons, sha: SHA }).success).toBe(true);
  });

  it('refuses a no-go without a reason', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [], sha: SHA }).success).toBe(false);
  });

  it('refuses more than five reasons, an empty reason and a reason over 300 characters', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: ['a', 'b', 'c', 'd', 'e', 'f'], sha: SHA }).success).toBe(false);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [''], sha: SHA }).success).toBe(false);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: ['x'.repeat(301)], sha: SHA }).success).toBe(false);
  });

  it.each([
    ['a short sha', 'abc1234'],
    ['an uppercase sha', 'A'.repeat(40)],
    ['a sha with a non hex character', `${'a'.repeat(39)}g`],
    ['a sha of 41 characters', 'a'.repeat(41)],
  ])('refuses %s', (_name, sha) => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'go', reasons: [], sha }).success).toBe(false);
  });

  it('refuses a verdict other than go or no-go', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'maybe', reasons: [], sha: SHA }).success).toBe(false);
  });
});
