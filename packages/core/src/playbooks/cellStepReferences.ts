import type { PlaybookCell } from '@openfleet/shared';
import { KernelError } from './kernel/kernelError.js';
import { stepIdsReferencedByTemplate } from './kernel/tokenResolver.js';

/** Stands for a read of the whole `steps` dictionary: no step id can spell it, so it is never a step the cell may own. */
export const EVERY_STEP = '*';

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

/** The ids of the steps read by the text and the conditions found in a value: `{{steps.<id>.<field>}}` tokens in any text, `steps.<id>.<field>` on the `lhs` of a condition. A plain text that merely contains "steps." reads nothing. */
const stepIdsReadIn = (value: unknown): string[] => {
  if (typeof value === 'string') return stepIdsOfTemplate(value);
  if (Array.isArray(value)) return value.flatMap(stepIdsReadIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) => (key === 'lhs' && typeof member === 'string' ? stepIdsOfConditionPath(member) : stepIdsReadIn(member)));
};

/** The ids of the steps a cell reads while it runs: its fields (never its edges nor its retry), and nothing else. */
export function stepIdsReadByTheCell(cell: PlaybookCell): string[] {
  const { retry: _retry, next: _next, ...whatTheCellRuns } = cell;
  return stepIdsReadIn(whatTheCellRuns);
}

/** The ids of the steps the `until` predicate of the retry of a cell reads. */
export function stepIdsReadByTheRetryPredicate(cell: PlaybookCell): string[] {
  return stepIdsReadIn(cell.retry?.until ?? []);
}
