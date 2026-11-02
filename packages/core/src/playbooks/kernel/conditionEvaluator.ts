import { canonicalJsonOf } from './canonicalDigest.js';
import { valueAtDottedPath } from './dottedPath.js';
import { KernelError } from './kernelError.js';

export const CONDITION_OPERATORS = [
  'contains',
  'ends_with',
  'eq',
  'exists',
  'gt',
  'gte',
  'lt',
  'lte',
  'neq',
  'not_contains',
  'not_exists',
  'starts_with',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type Condition = {
  path: string;
  operator: ConditionOperator;
  value?: unknown;
  caseInsensitive?: boolean;
  /** How this condition joins the previous one; the first condition's join is ignored (forced to `and`). */
  join?: 'and' | 'or';
};

export const MAX_CONDITIONS = 32;

type Comparison = { actual: unknown; expected: unknown; caseInsensitive: boolean };

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

const foldedCase = (value: unknown, caseInsensitive: boolean): unknown => (caseInsensitive && typeof value === 'string' ? value.toLowerCase() : value);

const isJsonStructure = (value: unknown): boolean => typeof value === 'object' && value !== null;

/** Primitives are equal when they have the same type and value (no coercion); objects and arrays when their canonical JSON is the same. */
const areEqual = ({ actual, expected, caseInsensitive }: Comparison): boolean => {
  const foldedActual = foldedCase(actual, caseInsensitive);
  const foldedExpected = foldedCase(expected, caseInsensitive);
  const areStructures = isJsonStructure(foldedActual) && isJsonStructure(foldedExpected);
  return areStructures ? canonicalJsonOf(foldedActual) === canonicalJsonOf(foldedExpected) : foldedActual === foldedExpected;
};

/** A string contains a string; an array contains an equal element; anything else contains nothing. */
const holds = ({ actual, expected, caseInsensitive }: Comparison): boolean => {
  if (Array.isArray(actual)) return actual.some((element) => areEqual({ actual: element, expected, caseInsensitive }));
  const areStrings = typeof actual === 'string' && typeof expected === 'string';
  if (!areStrings) return false;
  return String(foldedCase(actual, caseInsensitive)).includes(String(foldedCase(expected, caseInsensitive)));
};

type StringComparison = (actual: string, expected: string) => boolean;

const onStrings =
  (compare: StringComparison) =>
  ({ actual, expected, caseInsensitive }: Comparison): boolean => {
    const areStrings = typeof actual === 'string' && typeof expected === 'string';
    return areStrings && compare(String(foldedCase(actual, caseInsensitive)), String(foldedCase(expected, caseInsensitive)));
  };

type OrderComparison = (comparison: number) => boolean;

/** Numbers order numerically, strings by UTF-16 code units (ISO dates order by time); a number against a string never orders. */
const ordering =
  (accepts: OrderComparison) =>
  ({ actual, expected, caseInsensitive }: Comparison): boolean => {
    if (typeof actual === 'number' && typeof expected === 'number') return accepts(Math.sign(actual - expected));
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    const foldedActual = String(foldedCase(actual, caseInsensitive));
    const foldedExpected = String(foldedCase(expected, caseInsensitive));
    const position = foldedActual < foldedExpected ? -1 : foldedActual > foldedExpected ? 1 : 0;
    return accepts(position);
  };

const OPERATOR_VERDICTS: Record<ConditionOperator, (comparison: Comparison) => boolean> = {
  eq: areEqual,
  neq: (comparison) => !areEqual(comparison),
  contains: holds,
  not_contains: (comparison) => !holds(comparison),
  starts_with: onStrings((actual, expected) => actual.startsWith(expected)),
  ends_with: onStrings((actual, expected) => actual.endsWith(expected)),
  gt: ordering((position) => position > 0),
  gte: ordering((position) => position >= 0),
  lt: ordering((position) => position < 0),
  lte: ordering((position) => position <= 0),
  exists: ({ actual }) => isPresent(actual),
  not_exists: ({ actual }) => !isPresent(actual),
};

const verdictOfCondition = (condition: Condition, context: unknown): boolean => {
  const verdictOf = Object.hasOwn(OPERATOR_VERDICTS, condition.operator) ? OPERATOR_VERDICTS[condition.operator] : undefined;
  if (!verdictOf) throw new KernelError('unknown_operator', `the operator "${String(condition.operator)}" is not one of ${CONDITION_OPERATORS.join(', ')}.`);
  const actual = valueAtDottedPath(context, condition.path);
  return verdictOf({ actual, expected: condition.value, caseInsensitive: condition.caseInsensitive === true });
};

/**
 * Returns whether `conditions` hold against `context` (an object read by dotted paths such as `event.row.x` or `steps.id.field`).
 * Consecutive `and` conditions form a group that must hold entirely; each `or` opens a new group and one holding group is enough.
 * The join of the first condition is ignored, and a missing join is `and`. No condition at all holds.
 * Values never coerce: a number against a string is false for every operator except `neq` and `not_contains`, their negations.
 * A null or absent value does not exist. More than MAX_CONDITIONS conditions, or an unknown operator, throws a KernelError.
 */
export const evaluateConditions = (conditions: readonly Condition[], context: unknown): boolean => {
  if (conditions.length > MAX_CONDITIONS) throw new KernelError('too_many_conditions', `a rule holds at most ${MAX_CONDITIONS} conditions, got ${conditions.length}.`);

  const groups: boolean[][] = [[]];
  conditions.forEach((condition, position) => {
    const opensAGroup = position > 0 && condition.join === 'or';
    if (opensAGroup) groups.push([]);
    groups[groups.length - 1]?.push(verdictOfCondition(condition, context));
  });

  const hasNoCondition = conditions.length === 0;
  return hasNoCondition || groups.some((group) => group.every(Boolean));
};
