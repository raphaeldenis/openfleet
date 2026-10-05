import type { Aggregate, DsColumn, DsRow } from '@openfleet/shared';
import { InvalidQueryError } from '../stores/dataStoreService.js';
import { requireColumn } from './rowValues.js';
import type { CellReader } from './toolViews.js';

type AggregateOp = Aggregate['op'];

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
  const needsOrderableColumn = op === 'min' || op === 'max';
  if (needsOrderableColumn && !isOrderable) throw new InvalidQueryError(`${op} needs a number, date or text column; "${column!.displayName}" is ${column!.columnType}`);
  const defaultAlias = column === undefined ? op : `${op}_${column.displayName}`;
  return { op, column, alias: aggregate.as ?? defaultAlias };
}

const isBefore = (column: DsColumn, a: unknown, b: unknown): boolean =>
  column.columnType === 'date' ? Date.parse(a as string) < Date.parse(b as string) : (a as number | string) < (b as number | string);

function finiteAggregate(value: number, op: AggregateOp): number {
  if (!Number.isFinite(value)) throw new InvalidQueryError(`${op} produces a non-finite result`);
  return value;
}

function averageOf(cells: number[]): number {
  const scale = cells.reduce((largest, cell) => Math.max(largest, Math.abs(cell)), 0);
  if (scale === 0) return 0;
  const normalizedSum = cells.reduce((total, cell) => total + cell / scale, 0);
  const normalizedMean = normalizedSum / cells.length;
  return finiteAggregate(normalizedMean * scale, 'avg');
}

function valueOf({ op, column }: ResolvedAggregate, rows: DsRow[]): unknown {
  if (op === 'count' && column === undefined) return rows.length;
  const cells = rows.map((row) => row.data[column!.id]).filter((cell) => !isEmptyCell(cell));
  if (op === 'count') return cells.length;
  if (op === 'sum') return finiteAggregate((cells as number[]).reduce((total, cell) => total + cell, 0), op);
  if (cells.length === 0) return null;
  if (op === 'avg') return averageOf(cells as number[]);
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
  if (groupColumns.length === 0) rowsByGroupKey.set('[]', []);
  for (const row of rows) {
    const groupKey = JSON.stringify(groupColumns.map((column) => row.data[column.id] ?? null));
    const groupRows = rowsByGroupKey.get(groupKey) ?? [];
    groupRows.push(row);
    rowsByGroupKey.set(groupKey, groupRows);
  }

  return [...rowsByGroupKey.values()].map((groupRows) => ({
    ...Object.fromEntries(groupColumns.map((column) => [column.displayName, cellOf(column.id, groupRows[0]!.data[column.id] ?? null)])),
    ...Object.fromEntries(aggregates.map((aggregate) => [aggregate.alias, valueOf(aggregate, groupRows)])),
  }));
}
