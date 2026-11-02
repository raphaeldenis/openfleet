import { TRIGGER_CONDITION_OPERATORS, MAX_TRIGGER_CONDITIONS } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { CONDITION_OPERATORS, MAX_CONDITIONS } from '../playbooks/kernel/conditionEvaluator.js';

describe('the condition vocabulary of the triggers', () => {
  it('is the one of the evaluator of the kernel: the same operators and the same cap', () => {
    expect([...TRIGGER_CONDITION_OPERATORS].sort()).toEqual([...CONDITION_OPERATORS].sort());
    expect(MAX_TRIGGER_CONDITIONS).toBe(MAX_CONDITIONS);
  });
});
