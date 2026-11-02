import type { TriggerCondition } from '@openfleet/shared';
import type { Condition } from '../playbooks/kernel/conditionEvaluator.js';

/** The conditions of a trigger in the shape the evaluator of the kernel reads. */
export const kernelConditionsOf = (conditions: readonly TriggerCondition[]): Condition[] =>
  conditions.map((condition) => ({
    path: condition.lhs, operator: condition.op, value: condition.rhs, caseInsensitive: condition.caseInsensitive, join: condition.join,
  }));
