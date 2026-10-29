import type { DsColumn, DsRow } from '@openfleet/shared';

export class RowGuardViolationError extends Error {}

export class JournalShortenedError extends RowGuardViolationError {
  constructor() {
    super('The journal can only grow: resend the previous journal unchanged, followed by your new line(s), instead of a shorter or rewritten text.');
  }
}

export class DoneWithoutPrUrlError extends RowGuardViolationError {
  constructor() {
    super('A row cannot be done without a pr_url: set pr_url in the same update, or set step to cancelled.');
  }
}

const nameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();

const columnNamed = (columns: DsColumn[], name: string): DsColumn | undefined => columns.find((column) => nameKey(column.displayName) === name);

const optionIdLabelled = (column: DsColumn | undefined, label: string): string | undefined => column?.options?.find((option) => nameKey(option.label) === label)?.id;

const textOf = (cell: unknown): string => (typeof cell === 'string' ? cell.normalize('NFC') : '');

/** Returns the guard the write breaks, or undefined when the row may change; `patch` follows the repository rule: an `undefined` cell is no change. */
export function rowGuardViolationOf(input: { columns: DsColumn[]; current: DsRow; patch: Record<string, unknown> }): RowGuardViolationError | undefined {
  const { columns, current, patch } = input;
  const touches = (column: DsColumn | undefined): column is DsColumn => column !== undefined && patch[column.id] !== undefined;

  const journal = columnNamed(columns, 'journal');
  if (touches(journal)) {
    const previousJournal = textOf(current.data[journal.id]);
    const nextJournal = textOf(patch[journal.id]);
    const keepsPreviousJournal = nextJournal.startsWith(previousJournal);
    if (!keepsPreviousJournal) return new JournalShortenedError();
  }

  const status = columnNamed(columns, 'status');
  const prUrl = columnNamed(columns, 'pr_url');
  const step = columnNamed(columns, 'step');
  const touchesDoneRule = [status, prUrl, step].some(touches);
  if (!touchesDoneRule || status === undefined || prUrl === undefined) return undefined;

  const resultingCell = (column: DsColumn): unknown => (patch[column.id] === undefined ? current.data[column.id] : patch[column.id]);
  const doneOptionId = optionIdLabelled(status, 'done');
  const isDone = doneOptionId !== undefined && resultingCell(status) === doneOptionId;
  const hasPrUrl = textOf(resultingCell(prUrl)).trim() !== '';
  const cancelledOptionId = optionIdLabelled(step, 'cancelled');
  const isCancelled = step !== undefined && cancelledOptionId !== undefined && resultingCell(step) === cancelledOptionId;
  return isDone && !hasPrUrl && !isCancelled ? new DoneWithoutPrUrlError() : undefined;
}
