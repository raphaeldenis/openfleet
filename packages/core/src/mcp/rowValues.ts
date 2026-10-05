import type { DsColumn } from '@openfleet/shared';
import { UnknownColumnReferenceError } from '../stores/dataStoreRepository.js';

/** The cell a select column stores for what an agent wrote: the id of the option whose id or label (any case) it is, else the value untouched. */
function selectOptionIdOf(column: DsColumn, value: unknown): unknown {
  const isSelectLabelOrId = column.columnType === 'select' && typeof value === 'string';
  if (!isSelectLabelOrId) return value;
  const options = column.options ?? [];
  const optionWithThatId = options.find((option) => option.id === value);
  if (optionWithThatId) return optionWithThatId.id;
  const optionWithThatLabel = options.find((option) => option.label.toLowerCase() === value.toLowerCase());
  return optionWithThatLabel?.id ?? value;
}

/**
 * Turns cells keyed by column id or display name (an id wins, a name matches in any case) into cells keyed by column id,
 * with select labels turned into option ids. A reference matching no column throws and nothing is returned.
 */
export function cellsKeyedByColumnId(columns: DsColumn[], values: Record<string, unknown>): Record<string, unknown> {
  const columnById = new Map(columns.map((column) => [column.id, column]));
  const columnByLowerCaseName = new Map(columns.map((column) => [column.displayName.toLowerCase(), column]));
  const columnFor = (reference: string) => columnById.get(reference) ?? columnByLowerCaseName.get(reference.toLowerCase());

  const unknownReferences = Object.keys(values).filter((reference) => !columnFor(reference));
  if (unknownReferences.length > 0) throw new UnknownColumnReferenceError(unknownReferences);

  return Object.fromEntries(Object.entries(values).map(([reference, value]) => {
    const column = columnFor(reference)!;
    return [column.id, selectOptionIdOf(column, value)];
  }));
}
