import { describe, expect, it } from 'vitest';
import { type Condition, type ConditionOperator, MAX_CONDITIONS, evaluateConditions } from './conditionEvaluator.js';
import { KernelError } from './kernelError.js';

const codeOfThrown = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof KernelError ? error.code : 'not_a_kernel_error';
  }
  return undefined;
};

/** Evaluates one condition against `{ field: actual }`; an `undefined` actual leaves the field absent. */
const verdictOf = (operator: ConditionOperator, actual: unknown, expected?: unknown, options: { caseInsensitive?: boolean } = {}): boolean => {
  const context = actual === undefined ? {} : { field: actual };
  return evaluateConditions([{ path: 'field', operator, value: expected, ...options }], context);
};

describe('evaluateConditions: operators (golden table)', () => {
  it.each([
    ['eq', 'open', 'open', true],
    ['eq', 'open', 'closed', false],
    ['eq', 5, 5, true],
    ['eq', true, true, true],
    ['eq', undefined, 'open', false],
    ['eq', { a: 1, b: 2 }, { b: 2, a: 1 }, true],
    ['eq', [1, 2], [2, 1], false],
    ['neq', 'open', 'closed', true],
    ['neq', 'open', 'open', false],
    ['neq', undefined, 'open', true],
    ['contains', 'release-notes', 'lease', true],
    ['contains', 'release-notes', 'zzz', false],
    ['contains', ['a', 'b'], 'b', true],
    ['contains', ['a', 'b'], 'c', false],
    ['contains', undefined, 'a', false],
    ['not_contains', 'release-notes', 'zzz', true],
    ['not_contains', 'release-notes', 'lease', false],
    ['not_contains', ['a'], 'b', true],
    ['not_contains', undefined, 'a', true],
    ['starts_with', 'release-notes', 'release', true],
    ['starts_with', 'release-notes', 'notes', false],
    ['ends_with', 'release-notes', 'notes', true],
    ['ends_with', 'release-notes', 'release', false],
    ['gt', 5, 3, true],
    ['gt', 3, 3, false],
    ['gte', 3, 3, true],
    ['gte', 2, 3, false],
    ['lt', 2, 3, true],
    ['lt', 3, 3, false],
    ['lte', 3, 3, true],
    ['lte', 4, 3, false],
    ['gt', '2026-11-02', '2026-10-31', true],
    ['lt', '2026-10-31', '2026-11-02', true],
    ['exists', 'x', undefined, true],
    ['exists', '', undefined, true],
    ['exists', 0, undefined, true],
    ['exists', null, undefined, false],
    ['exists', undefined, undefined, false],
    ['not_exists', undefined, undefined, true],
    ['not_exists', null, undefined, true],
    ['not_exists', 'x', undefined, false],
  ] as const)('%s: actual %j against %j is %s', (operator, actual, expected, verdict) => {
    expect(verdictOf(operator, actual, expected)).toBe(verdict);
  });
});

describe('evaluateConditions: mismatched types never coerce', () => {
  it.each([
    ['eq', 5, '5'],
    ['eq', '5', 5],
    ['gt', 10, '9'],
    ['gt', '10', 9],
    ['gte', '10', 9],
    ['lt', 1, '2'],
    ['lte', '1', 2],
    ['contains', 12345, '23'],
    ['contains', 'abc', 1],
    ['starts_with', 123, '1'],
    ['ends_with', 'a1', 1],
  ] as const)('%s on actual %j against %j is false', (operator, actual, expected) => {
    expect(verdictOf(operator, actual, expected)).toBe(false);
  });

  it('answers neq and not_contains true for mismatched types, as the negation of eq and contains', () => {
    expect(verdictOf('neq', 5, '5')).toBe(true);
    expect(verdictOf('not_contains', 12345, '23')).toBe(true);
  });
});

describe('evaluateConditions: caseInsensitive', () => {
  it.each([
    ['eq', 'Open', 'open'],
    ['contains', 'Release-Notes', 'LEASE'],
    ['starts_with', 'Release', 'rel'],
    ['ends_with', 'Release', 'ASE'],
    ['contains', ['Alpha', 'Beta'], 'beta'],
  ] as const)('%s matches %j with %j when caseInsensitive', (operator, actual, expected) => {
    expect(verdictOf(operator, actual, expected, { caseInsensitive: true })).toBe(true);
    expect(verdictOf(operator, actual, expected)).toBe(false);
  });

  it('negates through neq and not_contains', () => {
    expect(verdictOf('neq', 'Open', 'open', { caseInsensitive: true })).toBe(false);
    expect(verdictOf('not_contains', 'Release', 'LEASE', { caseInsensitive: true })).toBe(false);
  });
});

describe('evaluateConditions: dotted paths', () => {
  const context = {
    event: { row: { status: 'open', labels: ['a', 'b'], 'odd-key': 7 } },
    steps: { build: { exit: { code: 0 } } },
  };

  it('reads a nested field of the event', () => {
    expect(evaluateConditions([{ path: 'event.row.status', operator: 'eq', value: 'open' }], context)).toBe(true);
  });

  it('reads a field of a step output', () => {
    expect(evaluateConditions([{ path: 'steps.build.exit.code', operator: 'eq', value: 0 }], context)).toBe(true);
  });

  it('reads an array element by index', () => {
    expect(evaluateConditions([{ path: 'event.row.labels.1', operator: 'eq', value: 'b' }], context)).toBe(true);
  });

  it('reads a key written with a dash', () => {
    expect(evaluateConditions([{ path: 'event.row.odd-key', operator: 'eq', value: 7 }], context)).toBe(true);
  });

  it('treats a path through a missing branch as absent', () => {
    expect(evaluateConditions([{ path: 'event.nothing.status', operator: 'not_exists' }], context)).toBe(true);
  });

  it('treats a path through a scalar as absent', () => {
    expect(evaluateConditions([{ path: 'event.row.status.length', operator: 'not_exists' }], context)).toBe(true);
  });

  it.each(['__proto__.polluted', 'event.constructor', 'event.row.toString', 'event.__proto__'])('never reads the prototype through %s', (path) => {
    expect(evaluateConditions([{ path, operator: 'not_exists' }], context)).toBe(true);
  });
});

describe('evaluateConditions: and/or grouping', () => {
  const T = { path: 'on', operator: 'eq', value: true } satisfies Condition;
  const F = { path: 'off', operator: 'eq', value: true } satisfies Condition;
  const context = { on: true, off: false };
  const and = (condition: Condition): Condition => ({ ...condition, join: 'and' });
  const or = (condition: Condition): Condition => ({ ...condition, join: 'or' });

  it('is true when there is no condition', () => {
    expect(evaluateConditions([], context)).toBe(true);
  });

  it('forces the join of the first condition to and, whatever it says', () => {
    expect(evaluateConditions([or(F)], context)).toBe(false);
    expect(evaluateConditions([or(T)], context)).toBe(true);
  });

  it('defaults a missing join to and', () => {
    expect(evaluateConditions([T, F], context)).toBe(false);
    expect(evaluateConditions([T, T], context)).toBe(true);
  });

  it('binds consecutive ands: all of them must hold', () => {
    expect(evaluateConditions([T, and(T), and(F)], context)).toBe(false);
  });

  it('opens a group at each or: any group fully true is enough', () => {
    expect(evaluateConditions([F, or(T)], context)).toBe(true);
    expect(evaluateConditions([F, or(F)], context)).toBe(false);
  });

  it('binds and tighter than or: A and B or C is (A and B) or C', () => {
    expect(evaluateConditions([F, and(T), or(T)], context)).toBe(true);
    expect(evaluateConditions([T, and(F), or(F)], context)).toBe(false);
  });

  it('binds and tighter than or on the right: A or B and C is A or (B and C)', () => {
    expect(evaluateConditions([F, or(T), and(F)], context)).toBe(false);
    expect(evaluateConditions([F, or(T), and(T)], context)).toBe(true);
    expect(evaluateConditions([T, or(F), and(F)], context)).toBe(true);
  });
});

describe('evaluateConditions: cap and unknown operators', () => {
  const trivial: Condition = { path: 'on', operator: 'exists' };

  it('exposes a cap of 32', () => {
    expect(MAX_CONDITIONS).toBe(32);
  });

  it('accepts 32 conditions', () => {
    expect(evaluateConditions(Array.from({ length: 32 }, () => trivial), { on: 1 })).toBe(true);
  });

  it('refuses the 33rd condition with too_many_conditions', () => {
    const thirtyThree = Array.from({ length: 33 }, () => trivial);

    expect(codeOfThrown(() => evaluateConditions(thirtyThree, { on: 1 }))).toBe('too_many_conditions');
  });

  it('refuses an operator outside the twelve with unknown_operator', () => {
    const wire = JSON.parse('[{"path":"on","operator":"matches","value":"x"}]') as Condition[];

    expect(codeOfThrown(() => evaluateConditions(wire, { on: 1 }))).toBe('unknown_operator');
  });
});
