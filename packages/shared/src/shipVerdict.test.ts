import { describe, expect, it } from 'vitest';
import { ShipVerdictSchema } from './shipVerdict.js';

const SHA = 'a'.repeat(40);
const readInCode = (text: string) => ({ claim: text, status: 'not_reproduced' });
const proven = { claim: 'the migration is not reversible', status: 'proven', command: 'pnpm vitest run migrate.test.ts', output: 'FAIL down migration' };

describe('ShipVerdictSchema', () => {
  it('accepts a go that carries the run it verified', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'go', reasons: [proven], sha: SHA }).success).toBe(true);
  });

  it('refuses a go without claim and a go whose claims were only read in the code', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'go', reasons: [], sha: SHA }).success).toBe(false);
    expect(ShipVerdictSchema.safeParse({ verdict: 'go', reasons: [readInCode('src/a.ts is fine')], sha: SHA }).success).toBe(false);
  });

  it('accepts a no-go that names one to five reasons', () => {
    const fiveReasons = ['a', 'b', 'c', 'd', 'e'].map(readInCode);

    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [proven], sha: SHA }).success).toBe(true);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: fiveReasons, sha: SHA }).success).toBe(true);
  });

  it('refuses a no-go without a reason', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [], sha: SHA }).success).toBe(false);
  });

  it('refuses more than five reasons, an empty reason and a reason over 300 characters', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: ['a', 'b', 'c', 'd', 'e', 'f'].map(readInCode), sha: SHA }).success).toBe(false);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [readInCode('')], sha: SHA }).success).toBe(false);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [readInCode('x'.repeat(301))], sha: SHA }).success).toBe(false);
  });

  it('refuses a plain text reason and a proven reason without output', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: ['broken'], sha: SHA }).success).toBe(false);
    expect(ShipVerdictSchema.safeParse({ verdict: 'no-go', reasons: [{ claim: 'c', status: 'proven', command: 'pnpm test' }], sha: SHA }).success).toBe(false);
  });

  it.each([
    ['a short sha', 'abc1234'],
    ['an uppercase sha', 'A'.repeat(40)],
    ['a sha with a non hex character', `${'a'.repeat(39)}g`],
    ['a sha of 41 characters', 'a'.repeat(41)],
  ])('refuses %s', (_name, sha) => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'go', reasons: [proven], sha }).success).toBe(false);
  });

  it('refuses a verdict other than go or no-go', () => {
    expect(ShipVerdictSchema.safeParse({ verdict: 'maybe', reasons: [proven], sha: SHA }).success).toBe(false);
  });
});
