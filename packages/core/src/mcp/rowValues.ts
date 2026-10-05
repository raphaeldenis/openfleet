import type { DsColumn } from '@openfleet/shared';
import { AmbiguousColumnReferenceError, UnknownColumnReferenceError } from '../stores/dataStoreRepository.js';
import { CellValueRejectedError, isValidCell } from '../stores/dataStoreService.js';

export type ColumnLookup = (reference: string) => DsColumn | undefined;

/** Finds a column by id, else by display name in any case; a name shared by several columns throws, an unmatched reference answers undefined. */
export function columnLookupFor(columns: DsColumn[]): ColumnLookup {
  const columnById = new Map(columns.map((column) => [column.id, column]));
  return (reference) => {
    const columnWithThatId = columnById.get(reference);
    if (columnWithThatId) return columnWithThatId;
    const lowerCaseReference = reference.toLowerCase();
    const columnsWithThatName = columns.filter((column) => column.displayName.toLowerCase() === lowerCaseReference);
    const isAmbiguous = columnsWithThatName.length > 1;
    if (isAmbiguous) throw new AmbiguousColumnReferenceError(reference, columnsWithThatName.map((column) => column.id));
    return columnsWithThatName[0];
  };
}

/** The column a reference names, or an UnknownColumnReferenceError. */
export function requireColumn(columns: DsColumn[], reference: string): DsColumn {
  const column = columnLookupFor(columns)(reference);
  if (!column) throw new UnknownColumnReferenceError([reference]);
  return column;
}

function selectOptionIdOf(column: DsColumn, label: string): string {
  const options = column.options ?? [];
  const optionWithThatId = options.find((option) => option.id === label);
  if (optionWithThatId) return optionWithThatId.id;
  const optionWithThatLabel = options.find((option) => option.label.toLowerCase() === label.toLowerCase());
  if (optionWithThatLabel) return optionWithThatLabel.id;
  const validLabels = options.map((option) => option.label).join(', ');
  throw new CellValueRejectedError(column.id, `"${label}" is not an option of column "${column.displayName}"; valid options: ${validLabels}`);
}

function numberOf(numericString: string): number | undefined {
  const isBlank = numericString.trim() === '';
  const parsed = Number(numericString);
  return isBlank || !Number.isFinite(parsed) ? undefined : parsed;
}

/** The cell a column stores for what an agent wrote: a numeric string becomes a number, a select label (any case) or id becomes the option id; any other value is left for the store to validate. */
export function coerceCellValue(column: DsColumn, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (column.columnType === 'select') return selectOptionIdOf(column, value);
  if (column.columnType === 'number') return numberOf(value) ?? value;
  return value;
}

/** The value a filter compares a column against: coerced like a cell, and refused when the column could never hold it. */
export function coerceFilterValue(column: DsColumn, value: unknown): unknown {
  const coerced = coerceCellValue(column, value);
  if (!isValidCell(column, coerced)) throw new CellValueRejectedError(column.id, `The value ${JSON.stringify(value)} cannot match the ${column.columnType} column "${column.displayName}"`);
  return coerced;
}

/**
 * Turns cells keyed by column id or display name (an id wins, a name matches in any case) into cells keyed by column id,
 * with values coerced to their column. A reference matching no column, or a name shared by several, throws and nothing is returned.
 */
export function cellsKeyedByColumnId(columns: DsColumn[], values: Record<string, unknown>): Record<string, unknown> {
  const columnFor = columnLookupFor(columns);
  const unknownReferences = Object.keys(values).filter((reference) => !columnFor(reference));
  if (unknownReferences.length > 0) throw new UnknownColumnReferenceError(unknownReferences);

  return Object.fromEntries(Object.entries(values).map(([reference, value]) => {
    const column = columnFor(reference)!;
    return [column.id, coerceCellValue(column, value)];
  }));
}
