import type { DsColumn } from '@openfleet/shared';

export interface CellEditRequest { rowId: string; column: DsColumn; trigger: HTMLElement }

export function canEditCell(column: DsColumn): boolean {
  return column.format !== undefined && column.autoValue === undefined;
}

export function editedCellValue(column: DsColumn, draft: string): { value: unknown; error: string | null } {
  switch (column.format) {
    case 'rank': return rankValue(draft);
    case 'datetime': return { value: draft, error: datetimeError(draft) };
    case 'url': return { value: draft, error: textSizeError(draft) ?? webUrlError(draft) };
    default: return { value: draft, error: textSizeError(draft) };
  }
}

function rankValue(draft: string): { value: number; error: string | null } {
  const value = Number(draft);
  const isFiniteRank = draft.trim() !== '' && Number.isFinite(value);
  return { value, error: isFiniteRank ? null : 'Enter a finite number, or use Clear value.' };
}

function datetimeError(draft: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(draft);
  const date = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) : null;
  const isCalendarDate = date !== null && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === draft.slice(0, 10);
  const isValidInstant = isCalendarDate && Number.isFinite(Date.parse(draft));
  return isValidInstant ? null : 'Enter an ISO date and time with Z or an offset, or use Clear value.';
}

function textSizeError(draft: string): string | null {
  const exceedsByteLimit = new TextEncoder().encode(draft).length > 64 * 1024;
  return exceedsByteLimit ? 'The text must fit within 64 KiB in UTF-8.' : null;
}

function webUrlError(draft: string): string | null {
  if (draft === '') return null;
  try {
    const url = new URL(draft);
    const isWebUrl = url.protocol === 'http:' || url.protocol === 'https:';
    return isWebUrl ? null : 'Enter an absolute HTTP or HTTPS URL.';
  } catch {
    return 'Enter an absolute HTTP or HTTPS URL.';
  }
}
