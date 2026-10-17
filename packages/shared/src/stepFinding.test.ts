import { describe, expect, it } from 'vitest';
import { StepFindingSchema } from './stepFinding.js';

const SHA = 'a'.repeat(40);

describe('StepFindingSchema', () => {
  it.each([
    ['a clean qe without claim', { step: 'qe', severity: 'clean', claims: [], sha: SHA }],
    ['a findings qa with one claim', { step: 'qa', severity: 'findings', claims: ['the filter is missing'], sha: SHA }],
    ['a ponytail with five claims of 300 characters', { step: 'ponytail', severity: 'findings', claims: Array.from({ length: 5 }, () => 'x'.repeat(300)), sha: SHA }],
  ])('accepts %s', (_name, input) => {
    expect(StepFindingSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['findings without claim', { step: 'qe', severity: 'findings', claims: [], sha: SHA }],
    ['six claims', { step: 'qe', severity: 'findings', claims: ['a', 'b', 'c', 'd', 'e', 'f'], sha: SHA }],
    ['an empty claim', { step: 'qe', severity: 'findings', claims: [''], sha: SHA }],
    ['a claim of 301 characters', { step: 'qe', severity: 'findings', claims: ['x'.repeat(301)], sha: SHA }],
    ['the adversarial step', { step: 'adversarial', severity: 'clean', claims: [], sha: SHA }],
    ['the go severity', { step: 'qe', severity: 'go', claims: [], sha: SHA }],
    ['a short sha', { step: 'qe', severity: 'clean', claims: [], sha: 'abc1234' }],
  ])('refuses %s', (_name, input) => {
    expect(StepFindingSchema.safeParse(input).success).toBe(false);
  });
});
