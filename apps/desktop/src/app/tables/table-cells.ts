import type { DsColumn, DsRow } from '@openfleet/shared';

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

export function sortedColumns(columns: DsColumn[]): DsColumn[] {
  return [...columns].sort((left, right) => left.sortOrder - right.sortOrder);
}

export function displayValue(column: DsColumn, value: unknown): string {
  if (isBlank(value)) return '';
  if (column.columnType === 'json') return JSON.stringify(value);
  if (column.columnType === 'select') {
    const matchingOption = column.options?.find((option) => option.id === value);
    return matchingOption?.label ?? String(value);
  }
  return String(value);
}

export function cellText(column: DsColumn, row: DsRow): string {
  return displayValue(column, row.data[column.id]);
}
