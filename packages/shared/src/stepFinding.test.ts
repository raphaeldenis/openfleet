import { describe, expect, it } from 'vitest';
import { StepFindingSchema } from './stepFinding.js';

const SHA = 'a'.repeat(40);
const readInCode = (text: string) => ({ claim: text, status: 'not_reproduced' });
const proven = { claim: 'the filter is missing', status: 'proven', command: 'pnpm vitest run filter.test.ts', output: 'FAIL filter.test.ts' };

describe('StepFindingSchema', () => {
  it.each([
    ['a clean qe with the run it verified', { step: 'qe', severity: 'clean', claims: [proven], sha: SHA }],
    ['a clean qa with a plausible claim and one read in the code', { step: 'qa', severity: 'clean', claims: [readInCode('src/a.ts'), { ...proven, status: 'plausible' }], sha: SHA }],
    ['a findings qa with one proven claim', { step: 'qa', severity: 'findings', claims: [proven], sha: SHA }],
    ['a findings qa with one claim read in the code', { step: 'qa', severity: 'findings', claims: [readInCode('src/a.ts:12 drops the filter')], sha: SHA }],
    ['a ponytail with five claims of 300 characters', { step: 'ponytail', severity: 'findings', claims: Array.from({ length: 5 }, () => readInCode('x'.repeat(300))), sha: SHA }],
  ])('accepts %s', (_name, input) => {
    expect(StepFindingSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['findings without claim', { step: 'qe', severity: 'findings', claims: [], sha: SHA }],
    ['six claims', { step: 'qe', severity: 'findings', claims: Array.from({ length: 6 }, () => readInCode('a')), sha: SHA }],
    ['an empty claim', { step: 'qe', severity: 'findings', claims: [readInCode('')], sha: SHA }],
    ['a claim of 301 characters', { step: 'qe', severity: 'findings', claims: [readInCode('x'.repeat(301))], sha: SHA }],
    ['a plain text claim', { step: 'qe', severity: 'findings', claims: ['the filter is missing'], sha: SHA }],
    ['a proven claim without output', { step: 'qe', severity: 'findings', claims: [{ claim: 'c', status: 'proven', command: 'pnpm test' }], sha: SHA }],
    ['a clean report without claim', { step: 'qe', severity: 'clean', claims: [], sha: SHA }],
    ['a clean report whose claims were only read in the code', { step: 'qe', severity: 'clean', claims: [readInCode('src/a.ts is fine')], sha: SHA }],
    ['the adversarial step', { step: 'adversarial', severity: 'clean', claims: [proven], sha: SHA }],
    ['the go severity', { step: 'qe', severity: 'go', claims: [proven], sha: SHA }],
    ['a short sha', { step: 'qe', severity: 'clean', claims: [proven], sha: 'abc1234' }],
  ])('refuses %s', (_name, input) => {
    expect(StepFindingSchema.safeParse(input).success).toBe(false);
  });

  it('keeps the evidence of each claim on the parsed finding', () => {
    const parsed = StepFindingSchema.parse({ step: 'qe', severity: 'findings', claims: [proven, readInCode('read in a.ts')], sha: SHA });

    expect(parsed.claims).toEqual([proven, readInCode('read in a.ts')]);
  });
});
