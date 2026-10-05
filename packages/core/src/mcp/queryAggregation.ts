import type { DsColumn, DsRow } from '@openfleet/shared';
import { z } from 'zod';
import { InvalidQueryError } from '../stores/dataStoreService.js';
import { requireColumn } from './rowValues.js';
import type { CellReader } from './toolViews.js';

const AGGREGATE_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
type AggregateOp = (typeof AGGREGATE_OPS)[number];

export const AggregateSchema = z.object({ op: z.enum(AGGREGATE_OPS), column: z.string().min(1).optional(), as: z.string().min(1).optional() });
export type Aggregate = z.infer<typeof AggregateSchema>;

interface ResolvedAggregate { op: AggregateOp; column: DsColumn | undefined; alias: string }

const isEmptyCell = (cell: unknown): boolean => cell === undefined || cell === null;
const COUNT_OF_ROWS: Aggregate = { op: 'count' };

function resolveAggregate(columns: DsColumn[], aggregate: Aggregate): ResolvedAggregate {
  const { op } = aggregate;
  const column = aggregate.column === undefined ? undefined : requireColumn(columns, aggregate.column);
  const needsColumn = op !== 'count';
  if (needsColumn && !column) throw new InvalidQueryError(`${op} needs a column`);
  const needsNumberColumn = op === 'sum' || op === 'avg';
  if (needsNumberColumn && column?.columnType !== 'number') throw new InvalidQueryError(`${op} needs a number column; "${column!.displayName}" is ${column!.columnType}`);
  const isOrderable = column === undefined || ['number', 'date', 'text'].includes(column.columnType);
  if (!isOrderable) throw new InvalidQueryError(`${op} needs a number, date or text column; "${column!.displayName}" is ${column!.columnType}`);
  const defaultAlias = column === undefined ? op : `${op}_${column.displayName}`;
  return { op, column, alias: aggregate.as ?? defaultAlias };
}

const isBefore = (column: DsColumn, a: unknown, b: unknown): boolean =>
  column.columnType === 'date' ? Date.parse(a as string) < Date.parse(b as string) : (a as number | string) < (b as number | string);

function valueOf({ op, column }: ResolvedAggregate, rows: DsRow[]): unknown {
  if (op === 'count' && column === undefined) return rows.length;
  const cells = rows.map((row) => row.data[column!.id]).filter((cell) => !isEmptyCell(cell));
  if (op === 'count') return cells.length;
  if (op === 'sum') return (cells as number[]).reduce((total, cell) => total + cell, 0);
  if (cells.length === 0) return null;
  if (op === 'avg') return (cells as number[]).reduce((total, cell) => total + cell, 0) / cells.length;
  const keepsCandidate = op === 'min' ? (candidate: unknown, kept: unknown) => isBefore(column!, candidate, kept) : (candidate: unknown, kept: unknown) => isBefore(column!, kept, candidate);
  return cells.reduce((kept, candidate) => (keepsCandidate(candidate, kept) ? candidate : kept));
}

/**
 * One object per group of rows sharing the `groupBy` cells (a single group of every row when none), in order of first appearance:
 * the group columns by display name, a select as its label, then each aggregate under its alias. No aggregate counts the rows.
 */
export function aggregatedRows(input: { columns: DsColumn[]; rows: DsRow[]; groupBy: string[]; aggregates: Aggregate[]; cellOf: CellReader }): Record<string, unknown>[] {
  const { columns, rows, cellOf } = input;
  const groupColumns = input.groupBy.map((reference) => requireColumn(columns, reference));
  const aggregates = (input.aggregates.length > 0 ? input.aggregates : [COUNT_OF_ROWS]).map((aggregate) => resolveAggregate(columns, aggregate));

  const rowsByGroupKey = new Map<string, DsRow[]>();
  for (const row of rows) {
    const groupKey = JSON.stringify(groupColumns.map((column) => row.data[column.id] ?? null));
    rowsByGroupKey.set(groupKey, [...(rowsByGroupKey.get(groupKey) ?? []), row]);
  }

  return [...rowsByGroupKey.values()].map((groupRows) => ({
    ...Object.fromEntries(groupColumns.map((column) => [column.displayName, cellOf(column.id, groupRows[0]!.data[column.id] ?? null)])),
    ...Object.fromEntries(aggregates.map((aggregate) => [aggregate.alias, valueOf(aggregate, groupRows)])),
  }));
}
