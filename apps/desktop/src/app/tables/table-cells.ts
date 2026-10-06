import type { DsColumn, DsRow } from '@openfleet/shared';

export const isBlank = (value: unknown) => value === undefined || value === null || value === '';

export function sortedColumns(columns: DsColumn[]): DsColumn[] {
  return [...columns].sort((left, right) => left.sortOrder - right.sortOrder);
}

export const textColumns = (columns: DsColumn[]): DsColumn[] => sortedColumns(columns).filter((column) => column.columnType === 'text');

export const selectColumnsWithOptions = (columns: DsColumn[]): DsColumn[] =>
  sortedColumns(columns).filter((column) => column.columnType === 'select' && column.options);

export function displayValue(column: DsColumn, value: unknown): string {
  if (isBlank(value)) return '';
  if (column.format === 'datetime' && typeof value === 'string') {
    const instant = new Date(value);
    const isValidInstant = !Number.isNaN(instant.getTime());
    if (isValidInstant) return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(instant);
  }
  if (column.columnType === 'json') return JSON.stringify(value);
  if (column.columnType === 'select') {
    const matchingOption = column.options?.find((option) => option.id === value);
    return matchingOption?.label ?? String(value);
  }
  return String(value);
}

export function clickableUrl(column: DsColumn, value: unknown): string | null {
  if (column.format !== 'url' || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const isWebUrl = url.protocol === 'http:' || url.protocol === 'https:';
    return isWebUrl ? url.href : null;
  } catch {
    return null;
  }
}

export function cellText(column: DsColumn, row: DsRow): string {
  return displayValue(column, row.data[column.id]);
}

export function titleOf(columns: DsColumn[], row: DsRow): string {
  const [titleColumn] = textColumns(columns);
  return titleColumn ? cellText(titleColumn, row) : '';
}
