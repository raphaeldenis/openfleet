import type { PlaybookCell } from '@openfleet/shared';
import { KernelError } from './kernel/kernelError.js';
import { stepIdsReferencedByTemplate } from './kernel/tokenResolver.js';

/** Stands for a read of the whole `steps` dictionary: no step id can spell it, so it is never a step the cell may own. */
export const EVERY_STEP = '*';

type ConditionPaths = readonly { lhs: string }[];

const stepIdsOfTemplate = (text: string): string[] => {
  try {
    return stepIdsReferencedByTemplate(text);
  } catch (error) {
    if (error instanceof KernelError) return [];
    throw error;
  }
};

/** The path is read by segments: `steps` reads every step, `steps.<id>` and `steps.<id>.<field>` read the step `<id>`. */
const stepIdsOfConditionPath = (path: string): string[] => {
  const [root, stepId] = path.split('.');
  const readsTheSteps = root === 'steps';
  if (!readsTheSteps) return [];
  return [stepId ?? EVERY_STEP];
};

/** The conditions of a waitFor predicate or of a retry `until` are the only fields that hold paths: the `lhs` of each one is read as a path. */
const stepIdsOfConditions = (conditions: ConditionPaths): string[] => conditions.flatMap(({ lhs }) => stepIdsOfConditionPath(lhs));

/** The fields a cell resolves as templates hold `{{steps.<id>.<field>}}` tokens, whatever their names: a plain text that merely contains "steps." reads nothing. */
const stepIdsOfTemplatesIn = (value: unknown): string[] => {
  if (typeof value === 'string') return stepIdsOfTemplate(value);
  if (Array.isArray(value)) return value.flatMap(stepIdsOfTemplatesIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(stepIdsOfTemplatesIn);
};

/** The ids of the steps a cell reads while it runs: the tokens of its resolved fields and the paths of its waitFor predicate (never its edges nor its retry). */
export function stepIdsReadByTheCell(cell: PlaybookCell): string[] {
  const { retry: _retry, next: _next, ...fields } = cell;
  const { predicate = [], ...resolvedFields } = fields as typeof fields & { predicate?: ConditionPaths };
  return [...stepIdsOfTemplatesIn(resolvedFields), ...stepIdsOfConditions(predicate)];
}

/** The ids of the steps the `until` predicate of the retry of a cell reads. */
export function stepIdsReadByTheRetryPredicate(cell: PlaybookCell): string[] {
  return stepIdsOfConditions(cell.retry?.until ?? []);
}
