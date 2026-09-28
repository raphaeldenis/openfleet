import type { DatabaseSync } from 'node:sqlite';
import {
  COLUMN_TYPES, DsViewConfigSchema, OrderTermSchema, SelectOptionSchema, VIEW_TYPES, WhereClauseSchema,
  type ColumnType, type DataStore, type DsColumn, type DsRow, type DsView, type DsViewConfig, type OrderTerm, type SelectOption, type ViewType, type WhereClause,
} from '@openfleet/shared';
import { z } from 'zod';
import { DuplicateNameError, StoreNotFoundError, UnknownColumnError, type DataStoreRepository, type RowActor } from './dataStoreRepository.js';

export class InvalidCellValueError extends Error {
  constructor(readonly columnId: string) {
    super(`Invalid value for column ${columnId}`);
  }
}
export class InvalidNameError extends Error {}
export class InvalidColumnDefinitionError extends Error {}
export class InvalidQueryError extends Error {}
export class InvalidViewConfigError extends Error {}
export class InvalidActorError extends Error {}
export class DuplicateIdError extends Error {}
export class ConstraintError extends Error {}
export class ViewNotFoundError extends Error {
  constructor(readonly viewId: string) {
    super(`View ${viewId} not found`);
  }
}
export class StoreHasRowsError extends Error {
  constructor(readonly storeId: string, readonly rowCount: number) {
    super(`Data store ${storeId} still has ${rowCount} rows; pass force to delete it with its history`);
  }
}

export interface DataStoreServiceDeps {
  repo: DataStoreRepository;
  db: DatabaseSync;
  /** Returns the current time as an ISO string. */
  clock: () => string;
  newId: () => string;
}
export interface KanbanGroup { option: SelectOption; rows: DsRow[] }
type Scope = { projectId: string };

const BATCH_SAVEPOINT = 'data_store_batch';
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const normalizeName = (name: string): string => {
  const normalized = name.normalize('NFC').trim();
  if (normalized === '') throw new InvalidNameError('A name cannot be empty');
  return normalized;
};

function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  return calendarDay.getUTCFullYear() === year && calendarDay.getUTCMonth() === month - 1 && calendarDay.getUTCDate() === day;
}

function isValidCell(column: DsColumn, value: unknown): boolean {
  if (value === null) return true;
  switch (column.columnType) {
    case 'text': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'date': return typeof value === 'string' && isIsoDate(value);
    case 'select': return typeof value === 'string' && (column.options ?? []).some((option) => option.id === value);
    case 'json': return !['undefined', 'function', 'symbol', 'bigint'].includes(typeof value);
  }
}

const isEmptyCell = (value: unknown): boolean => value === undefined || value === null;
const typeRank = (value: unknown): number => (typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : typeof value === 'boolean' ? 2 : 3);

/** Total order that never throws: numbers, then strings, then booleans, then the rest (all equal). */
function compareCells(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return typeRank(a) - typeRank(b);
}

/** Ordering for gt/gte/lt/lte: undefined when the two values cannot be compared (a mismatch never matches). */
function orderOf(column: DsColumn, cell: unknown, target: unknown): number | undefined {
  if (typeof cell === 'number' && typeof target === 'number') return Number.isNaN(cell - target) ? undefined : cell - target;
  if (typeof cell !== 'string' || typeof target !== 'string') return undefined;
  if (column.columnType === 'date') {
    const [cellTime, targetTime] = [Date.parse(cell), Date.parse(target)];
    return Number.isNaN(cellTime) || Number.isNaN(targetTime) ? undefined : cellTime - targetTime;
  }
  return compareCells(cell, target);
}

function matches(column: DsColumn, cell: unknown, clause: WhereClause): boolean {
  const { op, value } = clause;
  switch (op) {
    case 'eq': return isSameValue(cell, value);
    case 'neq': return !isSameValue(cell, value);
    case 'contains': return typeof cell === 'string' && typeof value === 'string' && cell.toLowerCase().includes(value.toLowerCase());
    default: {
      const order = orderOf(column, cell, value);
      if (order === undefined) return false;
      return op === 'gt' ? order > 0 : op === 'gte' ? order >= 0 : op === 'lt' ? order < 0 : order <= 0;
    }
  }
}

const isSameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Maps raw SQLite errors to typed ones so no SQL text leaves the service. */
function mapDatabaseError(error: unknown): unknown {
  if (!(error instanceof Error) || !/constraint failed/i.test(error.message)) return error;
  if (/UNIQUE constraint failed: \w+\.id\b|PRIMARY KEY/i.test(error.message)) return new DuplicateIdError('That id is already in use');
  if (/actor_kind/i.test(error.message)) return new InvalidActorError('Actor kind must be human, agent or trigger');
  if (/UNIQUE constraint failed/i.test(error.message)) return new DuplicateNameError('name');
  if (/FOREIGN KEY/i.test(error.message)) return new ConstraintError('A referenced record does not exist');
  return new ConstraintError('The data violates a store constraint');
}

export class DataStoreService {
  private readonly repo: DataStoreRepository;
  private readonly db: DatabaseSync;
  private readonly clock: () => string;
  private readonly newId: () => string;

  constructor(deps: DataStoreServiceDeps) {
    ({ repo: this.repo, db: this.db, clock: this.clock, newId: this.newId } = deps);
  }

  createStore(input: Scope & { displayName: string }): DataStore {
    const displayName = normalizeName(input.displayName);
    return this.guarded(() => this.repo.createStore({ id: this.newId(), projectId: input.projectId, displayName, at: this.clock() }));
  }

  addColumn(storeId: string, input: Scope & { displayName: string; columnType: ColumnType; options?: SelectOption[] }): DsColumn {
    this.authorize(storeId, input.projectId);
    const displayName = normalizeName(input.displayName);
    const options = this.validateColumnDefinition(input.columnType, input.options);
    return this.guarded(() => this.repo.addColumn(storeId, {
      id: this.newId(), displayName, columnType: input.columnType, ...(options ? { options } : {}), at: this.clock(),
    }));
  }

  insertRow(storeId: string, input: Scope & { data: Record<string, unknown>; actor: RowActor }): DsRow {
    this.authorize(storeId, input.projectId);
    this.validateCells(storeId, input.data);
    return this.guarded(() => this.repo.insertRow(storeId, { id: this.newId(), data: input.data, actor: input.actor, at: this.clock() }));
  }

  updateRow(storeId: string, rowId: string, input: Scope & { patch: Record<string, unknown>; actor: RowActor }): DsRow {
    this.authorize(storeId, input.projectId);
    this.validateCells(storeId, input.patch);
    return this.guarded(() => this.repo.updateRow(rowId, { storeId, patch: input.patch, actor: input.actor, at: this.clock() }));
  }

  deleteRow(storeId: string, rowId: string, input: Scope & { actor: RowActor }): void {
    this.authorize(storeId, input.projectId);
    this.guarded(() => this.repo.deleteRow(rowId, { storeId, actor: input.actor, at: this.clock() }));
  }

  /** Refuses a store that still has rows unless `force`: deleting it cascades away the tombstone history. */
  deleteStore(storeId: string, input: Scope & { force?: boolean }): void {
    this.authorize(storeId, input.projectId);
    this.inTransaction(() => {
      const rowCount = this.repo.listRows(storeId).length;
      if (rowCount > 0 && input.force !== true) throw new StoreHasRowsError(storeId, rowCount);
      this.repo.deleteStore(storeId);
    });
  }

  insertRows(storeId: string, input: Scope & { items: Record<string, unknown>[]; actor: RowActor }): DsRow[] {
    this.authorize(storeId, input.projectId);
    for (const data of input.items) this.validateCells(storeId, data);
    return this.inTransaction(() => input.items.map((data) => this.repo.insertRow(storeId, { id: this.newId(), data, actor: input.actor, at: this.clock() })));
  }

  updateRows(storeId: string, input: Scope & { items: { rowId: string; patch: Record<string, unknown> }[]; actor: RowActor }): DsRow[] {
    this.authorize(storeId, input.projectId);
    for (const { patch } of input.items) this.validateCells(storeId, patch);
    return this.inTransaction(() => input.items.map(({ rowId, patch }) => this.repo.updateRow(rowId, { storeId, patch, actor: input.actor, at: this.clock() })));
  }

  query(storeId: string, input: Scope & { where?: WhereClause[]; orderBy?: OrderTerm[]; limit?: number }): DsRow[] {
    this.authorize(storeId, input.projectId);
    return this.runQuery(storeId, input);
  }

  createView(storeId: string, input: Scope & { displayName: string; viewType: ViewType; config?: DsViewConfig }): DsView {
    this.authorize(storeId, input.projectId);
    const displayName = normalizeName(input.displayName);
    if (!VIEW_TYPES.includes(input.viewType)) throw new InvalidViewConfigError(`Unknown view type ${String(input.viewType)}`);
    const parsed = DsViewConfigSchema.safeParse(input.config ?? {});
    if (!parsed.success) throw new InvalidViewConfigError('Invalid view config');
    const config = parsed.data;
    this.requireColumns(storeId, [
      ...(config.where ?? []).map((clause) => clause.columnId),
      ...(config.orderBy ?? []).map((term) => term.columnId),
      ...(config.groupByColumnId ? [config.groupByColumnId] : []),
    ]);
    return this.guarded(() => this.repo.insertView(storeId, { id: this.newId(), displayName, viewType: input.viewType, config, at: this.clock() }));
  }

  listViews(storeId: string, input: Scope): DsView[] {
    this.authorize(storeId, input.projectId);
    return this.repo.listViews(storeId);
  }

  /** One bucket per select option in option order, empty ones included. Rows with no (or a stale) value are left out. */
  kanbanGroups(viewId: string, input: Scope): KanbanGroup[] {
    const view = this.repo.findView(viewId);
    const owner = view ? this.repo.findStore(view.storeId) : undefined;
    if (!view || owner?.projectId !== input.projectId) throw new ViewNotFoundError(viewId);

    const groupBy = this.repo.listColumns(view.storeId).find((column) => column.id === view.config.groupByColumnId);
    if (groupBy?.columnType !== 'select') throw new InvalidViewConfigError('The kanban group-by column must be a select column');

    const rows = this.runQuery(view.storeId, { where: view.config.where, orderBy: view.config.orderBy });
    return (groupBy.options ?? []).map((option) => ({ option, rows: rows.filter((row) => row.data[groupBy.id] === option.id) }));
  }

  private authorize(storeId: string, projectId: string): void {
    if (this.repo.findStore(storeId)?.projectId !== projectId) throw new StoreNotFoundError(storeId);
  }

  private requireColumns(storeId: string, columnIds: string[]): DsColumn[] {
    const columns = this.repo.listColumns(storeId);
    const known = new Set(columns.map((column) => column.id));
    const unknown = columnIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new UnknownColumnError(unknown);
    return columns;
  }

  private validateColumnDefinition(columnType: ColumnType, options: SelectOption[] | undefined): SelectOption[] | undefined {
    if (!COLUMN_TYPES.includes(columnType)) throw new InvalidColumnDefinitionError(`Unknown column type ${String(columnType)}`);
    if (columnType !== 'select') {
      if (options !== undefined) throw new InvalidColumnDefinitionError('Only a select column takes options');
      return undefined;
    }
    const parsed = z.array(SelectOptionSchema).min(1).safeParse(options);
    if (!parsed.success) throw new InvalidColumnDefinitionError('A select column needs at least one option, each with an id and a label');
    const hasDuplicateIds = new Set(parsed.data.map((option) => option.id)).size !== parsed.data.length;
    if (hasDuplicateIds) throw new InvalidColumnDefinitionError('Option ids must be unique');
    return parsed.data;
  }

  /** Checks every non-undefined cell against its column type; an `undefined` cell is no change and is skipped. */
  private validateCells(storeId: string, cells: Record<string, unknown>): void {
    const columns = this.requireColumns(storeId, Object.keys(cells));
    for (const column of columns) {
      const value = cells[column.id];
      if (Object.hasOwn(cells, column.id) && value !== undefined && !isValidCell(column, value)) throw new InvalidCellValueError(column.id);
    }
  }

  private runQuery(storeId: string, input: { where?: WhereClause[] | undefined; orderBy?: OrderTerm[] | undefined; limit?: number | undefined }): DsRow[] {
    const where = z.array(WhereClauseSchema).safeParse(input.where ?? []);
    const orderBy = z.array(OrderTermSchema).safeParse(input.orderBy ?? []);
    if (!where.success || !orderBy.success) throw new InvalidQueryError('Invalid where or orderBy');
    const { limit } = input;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new InvalidQueryError('limit must be a non-negative integer');

    const columns = this.requireColumns(storeId, [...where.data.map((c) => c.columnId), ...orderBy.data.map((t) => t.columnId)]);
    const columnById = new Map(columns.map((column) => [column.id, column]));

    // ponytail: in-memory filter; push down to SQL if stores grow past ~10k rows
    const filtered = this.repo.listRows(storeId).filter((row) =>
      where.data.every((clause) => matches(columnById.get(clause.columnId)!, row.data[clause.columnId] ?? null, clause)));
    const sorted = filtered.sort((a, b) => {
      for (const { columnId, dir } of orderBy.data) {
        const [cellA, cellB] = [a.data[columnId], b.data[columnId]];
        if (isEmptyCell(cellA) !== isEmptyCell(cellB)) return isEmptyCell(cellA) ? 1 : -1;
        const order = compareCells(cellA, cellB);
        if (order !== 0) return dir === 'asc' ? order : -order;
      }
      return 0;
    });
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }

  private guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  /** One outer transaction (or a savepoint when the caller holds one) so a batch is all-or-nothing; the repository nests inside. */
  private inTransaction<T>(work: () => T): T {
    const isInsideCallerTransaction = this.db.isTransaction;
    this.db.exec(isInsideCallerTransaction ? `SAVEPOINT ${BATCH_SAVEPOINT}` : 'BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec(isInsideCallerTransaction ? `RELEASE ${BATCH_SAVEPOINT}` : 'COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec(isInsideCallerTransaction ? `ROLLBACK TO ${BATCH_SAVEPOINT}; RELEASE ${BATCH_SAVEPOINT}` : 'ROLLBACK');
      throw mapDatabaseError(error);
    }
  }
}
