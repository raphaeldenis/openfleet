import type { ActivityRow } from '@openfleet/shared';

const CSV_COLUMNS = [
  'id', 'at', 'actorKind', 'actorLabel', 'source', 'action', 'entityKind', 'entityId', 'entityLabel', 'outcome',
  'durationMs', 'sessionId', 'managerId', 'detail', 'argsExcerpt', 'resultExcerpt',
] as const satisfies ReadonlyArray<keyof ActivityRow>;

const LINE_BREAK = '\r\n';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function csvCellOf(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  const startsLikeFormula = typeof value === 'string' && FORMULA_START.test(text);
  const safeText = startsLikeFormula ? `'${text}` : text;
  return NEEDS_QUOTES.test(safeText) || startsLikeFormula ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

/** The rows as CSV, one line per row under a header; a cell that starts like a spreadsheet formula is prefixed so it stays text. */
export function activityAsCsv(rows: readonly ActivityRow[]): string {
  const lines = rows.map((row) => CSV_COLUMNS.map((column) => csvCellOf(row[column])).join(','));
  return [CSV_COLUMNS.join(','), ...lines].join(LINE_BREAK);
}

/** The rows as an indented JSON list. */
export function activityAsJson(rows: readonly ActivityRow[]): string {
  return JSON.stringify(rows, null, 2);
}
