import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  COLUMN_TYPES, DsViewConfigSchema, OrderTermSchema, SelectOptionSchema, VIEW_TYPES, WhereClauseSchema,
  type AutoValue, type ColumnType, type DataStore, type DsColumn, type DsRow, type DsView, type DsViewConfig, type OrderTerm, type SelectOption, type ViewType, type WhereClause,
} from '@openfleet/shared';
import { z } from 'zod';
import { inTransaction as runInTransaction } from '../db/transaction.js';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError, type DataStoreRepository, type RowActor } from './dataStoreRepository.js';

export class InvalidCellValueError extends Error {
  constructor(readonly columnId: string) {
    super(`Invalid value for column ${columnId}`);
  }
}
/** A value refused for a column, with the words that tell the caller what would be accepted. */
export class CellValueRejectedError extends InvalidCellValueError {
  constructor(columnId: string, reason: string) {
    super(columnId);
    this.message = reason;
  }
}
export class InvalidNameError extends Error {}
export class InvalidColumnDefinitionError extends Error {}
export class InvalidQueryError extends Error {}
export class NoNaturalKeyError extends InvalidQueryError {
  constructor() {
    super('The data store has no natural key; address the row by row_id');
  }
}
export class AmbiguousNaturalKeyError extends InvalidQueryError {
  constructor() {
    super('Several rows hold that natural key; address the row by row_id');
  }
}
export class NaturalKeyMissingError extends InvalidQueryError {
  constructor() {
    super('The row needs a value for the natural key of the data store');
  }
}
export class NaturalKeyOnSeveralRowsError extends InvalidQueryError {
  constructor(matchedRowCount: number) {
    super(`The natural key cannot be set on several rows at once; the filter matches ${matchedRowCount} rows`);
  }
}
export class NaturalKeyNotFoundError extends InvalidQueryError {
  constructor(key: string) {
    super(`No row holds the natural key "${key}"`);
  }
}
export class DaemonSetColumnError extends Error {}
export class InvalidViewConfigError extends Error {}
export class InvalidActorError extends Error {}
export class DuplicateIdError extends Error {}
export class ConstraintError extends Error {}
export class ReferencedRecordMissingError extends ConstraintError {}
export class NaturalKeyConflictError extends ConstraintError {
  constructor(key: string) {
    super(`Another row already holds the natural key "${key}"`);
  }
}
export class NaturalKeyNotUniqueError extends ConstraintError {
  constructor() {
    super('Rows of this data store already share a value in that column, so it cannot be its natural key');
  }
}
export class DataStoreWriteError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
  }
}
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
export class StoreRowCapError extends Error {
  constructor(readonly storeId: string, readonly cap: number) {
    super(`Data store ${storeId} is at its ${cap}-row cap`);
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
export const SAVE_MODES = ['create', 'upsert', 'update'] as const;
export type SaveMode = (typeof SAVE_MODES)[number];

const BATCH_SAVEPOINT = 'data_store_batch';
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
export const MAX_CELL_BYTES = 64 * 1024;
export const MAX_ROWS_PER_STORE = 10_000;
export const MAX_VIEW_CONFIG_BYTES = 16 * 1024;

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

export function isValidCell(column: DsColumn, value: unknown): boolean {
  if (value === null) return true;
  switch (column.columnType) {
    case 'text': return typeof value === 'string' && !exceedsCellByteCap(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'date': return typeof value === 'string' && isIsoDate(value);
    case 'select': return typeof value === 'string' && (column.options ?? []).some((option) => option.id === value);
    case 'json': return survivesJsonRoundTrip(value) && !exceedsCellByteCap(JSON.stringify(value));
  }
}

/** A text or json cell's serialized value must fit within MAX_CELL_BYTES: one agent can't grow a row without bound. */
function exceedsCellByteCap(serialized: string): boolean {
  return Buffer.byteLength(serialized, 'utf8') > MAX_CELL_BYTES;
}

/** A json cell is only valid if it comes back unchanged from JSON.stringify/parse: no NaN, Infinity, -0, Date, undefined, function… */
function survivesJsonRoundTrip(value: unknown): boolean {
  try {
    return isDeepStrictEqual(value, JSON.parse(JSON.stringify(value)) as unknown);
  } catch {
    return false;
  }
}

const isEmptyCell = (value: unknown): boolean => value === undefined || value === null;
const typeRank = (value: unknown): number => (typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : typeof value === 'boolean' ? 2 : 3);

/** Total order that never throws: numbers, then strings (parsed as dates for a date column), then booleans, then the rest (all equal). */
function compareCells(column: DsColumn, a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    if (column.columnType === 'date') {
      const [timeA, timeB] = [Date.parse(a), Date.parse(b)];
      if (!Number.isNaN(timeA) && !Number.isNaN(timeB)) return timeA - timeB;
    }
    // ponytail: ordinal code-point order is deterministic; add localeCompare later if users need alphabetic sorting
    return a < b ? -1 : a > b ? 1 : 0;
  }
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
  return compareCells(column, cell, target);
}

function matches(column: DsColumn, cell: unknown, clause: WhereClause): boolean {
  const { op, value } = clause;
  switch (op) {
    case 'eq': return isSameValue(cell, value);
    case 'neq': return !isSameValue(cell, value);
    case 'in': return Array.isArray(value) && value.some((candidate) => isSameValue(cell, candidate));
    case 'contains': return typeof cell === 'string' && typeof value === 'string' && cell.toLowerCase().includes(value.toLowerCase());
    default: {
      const order = orderOf(column, cell, value);
      if (order === undefined) return false;
      return op === 'gt' ? order > 0 : op === 'gte' ? order >= 0 : op === 'lt' ? order < 0 : order <= 0;
    }
  }
}

const isSameValue = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a ?? null, b ?? null);

/** Maps raw SQLite errors to typed ones so no SQL text leaves the service; a typed application error (not from SQLite) passes through untouched. */
function mapDatabaseError(error: unknown): unknown {
  const isSqliteError = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR';
  if (!isSqliteError) return error;
  if (!/constraint failed/i.test(error.message)) return new DataStoreWriteError('The write failed', { cause: error });
  if (/UNIQUE constraint failed: \w+\.id\b|PRIMARY KEY/i.test(error.message)) return new DuplicateIdError('That id is already in use');
  if (/actor_kind/i.test(error.message)) return new InvalidActorError('Actor kind must be human, agent or trigger');
  if (/UNIQUE constraint failed/i.test(error.message)) return new DuplicateNameError('name');
  if (/FOREIGN KEY/i.test(error.message)) return new ReferencedRecordMissingError('A referenced record does not exist');
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

  addColumn(storeId: string, input: Scope & { displayName: string; columnType: ColumnType; options?: SelectOption[]; autoValue?: AutoValue }): DsColumn {
    this.authorize(storeId, input.projectId);
    const displayName = normalizeName(input.displayName);
    const options = this.validateColumnDefinition(input.columnType, input.options);
    const isDaemonSetOnNonDate = input.autoValue !== undefined && input.columnType !== 'date';
    if (isDaemonSetOnNonDate) throw new InvalidColumnDefinitionError('Only a date column can take an auto_value');
    return this.guarded(() => this.repo.addColumn(storeId, {
      id: this.newId(), displayName, columnType: input.columnType, ...(options ? { options } : {}), autoValue: input.autoValue, at: this.clock(),
    }));
  }

  /** Makes a text column of the store its natural key, or clears the key with `null`. */
  setNaturalKey(storeId: string, input: Scope & { columnId: string | null }): void {
    this.authorize(storeId, input.projectId);
    const { columnId } = input;
    if (columnId !== null) {
      const column = this.repo.listColumns(storeId).find((storeColumn) => storeColumn.id === columnId);
      if (column?.columnType !== 'text') throw new InvalidColumnDefinitionError('The natural key must be a text column of this data store');
      const heldValues = this.repo.listRows(storeId).map((row) => row.data[columnId]).filter((value) => typeof value === 'string');
      const sharesValueBetweenRows = new Set(heldValues).size !== heldValues.length;
      if (sharesValueBetweenRows) throw new NaturalKeyNotUniqueError();
    }
    this.guarded(() => this.repo.setNaturalKeyColumn(storeId, { columnId, at: this.clock() }));
  }

  /** The one row whose natural key cell equals `key` exactly. */
  findRowByNaturalKey(storeId: string, input: Scope & { key: string }): DsRow {
    this.authorize(storeId, input.projectId);
    const naturalKeyColumnId = this.repo.findStore(storeId)?.naturalKeyColumnId;
    if (naturalKeyColumnId === undefined) throw new NoNaturalKeyError();
    const matchingRows = this.runQuery(storeId, { where: [{ columnId: naturalKeyColumnId, op: 'eq', value: input.key }], limit: 2 });
    const [matchingRow, otherMatchingRow] = matchingRows;
    if (matchingRow === undefined) throw new RowNotFoundError(input.key);
    if (otherMatchingRow !== undefined) throw new AmbiguousNaturalKeyError();
    return matchingRow;
  }

  /**
   * Writes one row according to what the store's natural key says about it: `create` inserts and refuses a key already held, `upsert` inserts or overwrites
   * the supplied cells, `update` overwrites and refuses an absent key. A store with no natural key inserts plainly (`update` is refused).
   */
  saveRow(storeId: string, input: Scope & { data: Record<string, unknown>; actor: RowActor; mode: SaveMode }): { outcome: 'inserted' | 'updated'; row: DsRow } {
    this.authorize(storeId, input.projectId);
    const { data, mode } = input;
    const insert = () => ({ outcome: 'inserted' as const, row: this.insertRow(storeId, input) });

    const naturalKeyColumnId = this.repo.findStore(storeId)?.naturalKeyColumnId;
    const hasNaturalKey = naturalKeyColumnId !== undefined;
    if (!hasNaturalKey) {
      if (mode === 'update') throw new NoNaturalKeyError();
      return insert();
    }

    const key = data[naturalKeyColumnId];
    const isKeyless = key === undefined || key === null;
    if (isKeyless) {
      if (mode !== 'create') throw new NaturalKeyMissingError();
      return insert();
    }
    if (typeof key !== 'string') throw new InvalidCellValueError(naturalKeyColumnId);

    const [rowHoldingKey, otherRowHoldingKey] = this.runQuery(storeId, { where: [{ columnId: naturalKeyColumnId, op: 'eq', value: key }], limit: 2 });
    if (otherRowHoldingKey !== undefined) throw new AmbiguousNaturalKeyError();
    if (rowHoldingKey === undefined) {
      if (mode === 'update') throw new NaturalKeyNotFoundError(key);
      return insert();
    }
    if (mode === 'create') throw new NaturalKeyConflictError(key);

    const daemonSetColumnIds = new Set(this.daemonSetColumns(this.repo.listColumns(storeId)).map((column) => column.id));
    const patch = Object.fromEntries(Object.entries(data).filter(([columnId]) => !daemonSetColumnIds.has(columnId)));
    return { outcome: 'updated', row: this.updateRow(storeId, rowHoldingKey.id, { ...input, patch }) };
  }

  insertRow(storeId: string, input: Scope & { data: Record<string, unknown>; actor: RowActor }): DsRow {
    this.authorize(storeId, input.projectId);
    const at = this.clock();
    const columns = this.repo.listColumns(storeId);
    const data = this.withDaemonSetCells(this.daemonSetColumns(columns), input.data, at);
    this.validateCells(columns, data);
    this.assertRowCapacity(storeId, 1);
    return this.guarded(() => this.repo.insertRow(storeId, { id: this.newId(), data, actor: input.actor, at }));
  }

  updateRow(storeId: string, rowId: string, input: Scope & { patch: Record<string, unknown>; actor: RowActor }): DsRow {
    this.authorize(storeId, input.projectId);
    this.refuseDaemonSetCells(storeId, input.patch);
    this.validateCells(this.repo.listColumns(storeId), input.patch);
    this.refuseNaturalKeyHeldByAnotherRow(storeId, rowId, input.patch);
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
      const rowCount = this.repo.countRows(storeId);
      if (rowCount > 0 && input.force !== true) throw new StoreHasRowsError(storeId, rowCount);
      this.repo.deleteStore(storeId);
    });
  }

  insertRows(storeId: string, input: Scope & { items: Record<string, unknown>[]; actor: RowActor }): DsRow[] {
    this.authorize(storeId, input.projectId);
    const columns = this.repo.listColumns(storeId);
    const daemonSetColumns = this.daemonSetColumns(columns);
    const stampedRows = input.items.map((item) => {
      const at = this.clock();
      return { at, data: this.withDaemonSetCells(daemonSetColumns, item, at) };
    });
    for (const { data } of stampedRows) this.validateCells(columns, data);
    this.assertRowCapacity(storeId, input.items.length);
    return this.inTransaction(() => stampedRows.map(({ data, at }) => this.repo.insertRow(storeId, { id: this.newId(), data, actor: input.actor, at })));
  }

  /**
   * Sets the same cells on every row matching the `where` equalities, all or nothing: an invalid cell refuses the call even when no row matches,
   * a failing write undoes the others. The natural key cannot be set through a filter matching several rows.
   */
  updateRowsWhere(storeId: string, input: Scope & { where: WhereClause[]; set: Record<string, unknown>; actor: RowActor }): { matched: number; updated: DsRow[] } {
    this.authorize(storeId, input.projectId);
    this.refuseDaemonSetCells(storeId, input.set);
    this.validateCells(this.repo.listColumns(storeId), input.set);

    const matchedRows = this.runQuery(storeId, { where: input.where });
    const naturalKeyColumnId = this.repo.findStore(storeId)?.naturalKeyColumnId;
    const setsNaturalKey = naturalKeyColumnId !== undefined && Object.hasOwn(input.set, naturalKeyColumnId);
    if (setsNaturalKey && matchedRows.length > 1) throw new NaturalKeyOnSeveralRowsError(matchedRows.length);

    const updated = this.updateRows(storeId, { ...input, items: matchedRows.map((row) => ({ rowId: row.id, patch: input.set })) });
    return { matched: matchedRows.length, updated };
  }

  /** The daemon-set columns that the given rows try to fill: they are dropped at insert, and the caller reports them. */
  ignoredDaemonSetColumnIds(storeId: string, input: Scope & { items: Record<string, unknown>[] }): string[] {
    this.authorize(storeId, input.projectId);
    return this.daemonSetColumns(this.repo.listColumns(storeId)).map((column) => column.id).filter((columnId) => input.items.some((item) => Object.hasOwn(item, columnId)));
  }

  updateRows(storeId: string, input: Scope & { items: { rowId: string; patch: Record<string, unknown> }[]; actor: RowActor }): DsRow[] {
    this.authorize(storeId, input.projectId);
    const columns = this.repo.listColumns(storeId);
    for (const { patch } of input.items) {
      this.refuseDaemonSetCells(storeId, patch);
      this.validateCells(columns, patch);
    }
    return this.inTransaction(() => input.items.map(({ rowId, patch }) => {
      this.refuseNaturalKeyHeldByAnotherRow(storeId, rowId, patch);
      return this.repo.updateRow(rowId, { storeId, patch, actor: input.actor, at: this.clock() });
    }));
  }

  query(storeId: string, input: Scope & { where?: WhereClause[]; orderBy?: OrderTerm[]; limit?: number }): DsRow[] {
    this.authorize(storeId, input.projectId);
    return this.runQuery(storeId, input);
  }

  createView(storeId: string, input: Scope & { displayName: string; viewType: ViewType; config?: DsViewConfig }): DsView {
    this.authorize(storeId, input.projectId);
    const displayName = normalizeName(input.displayName);
    if (!VIEW_TYPES.includes(input.viewType)) throw new InvalidViewConfigError(`Unknown view type ${String(input.viewType)}`);
    const config = this.validatedConfig(storeId, input.viewType, input.config ?? {});
    return this.guarded(() => this.repo.insertView(storeId, { id: this.newId(), displayName, viewType: input.viewType, config, at: this.clock() }));
  }

  listViews(storeId: string, input: Scope): DsView[] {
    this.authorize(storeId, input.projectId);
    return this.repo.listViews(storeId);
  }

  updateView(viewId: string, input: Scope & { config: DsViewConfig }): DsView {
    const view = this.authorizeView(viewId, input.projectId);
    const config = this.validatedConfig(view.storeId, view.viewType, input.config);
    return this.guarded(() => this.repo.updateView(viewId, config));
  }

  deleteView(viewId: string, input: Scope): void {
    this.authorizeView(viewId, input.projectId);
    this.guarded(() => this.repo.deleteView(viewId));
  }

  /** One bucket per select option in option order, empty ones included. Rows with no (or a stale) value are left out. */
  kanbanGroups(viewId: string, input: Scope): KanbanGroup[] {
    const view = this.authorizeView(viewId, input.projectId);

    const groupBy = this.repo.listColumns(view.storeId).find((column) => column.id === view.config.groupByColumnId);
    if (groupBy?.columnType !== 'select') throw new InvalidViewConfigError('The kanban group-by column must be a select column');

    const rows = this.runQuery(view.storeId, { where: view.config.where, orderBy: view.config.orderBy });
    return (groupBy.options ?? []).map((option) => ({ option, rows: rows.filter((row) => row.data[groupBy.id] === option.id) }));
  }

  /** Refuses a patch that would give a row the natural key value another row of the store holds. */
  private refuseNaturalKeyHeldByAnotherRow(storeId: string, rowId: string, patch: Record<string, unknown>): void {
    const naturalKeyColumnId = this.repo.findStore(storeId)?.naturalKeyColumnId;
    const patchedKey = naturalKeyColumnId === undefined ? undefined : patch[naturalKeyColumnId];
    if (typeof patchedKey !== 'string') return;
    const rowsHoldingKey = this.runQuery(storeId, { where: [{ columnId: naturalKeyColumnId!, op: 'eq', value: patchedKey }] });
    const isHeldByAnotherRow = rowsHoldingKey.some((row) => row.id !== rowId);
    if (isHeldByAnotherRow) throw new NaturalKeyConflictError(patchedKey);
  }

  private authorize(storeId: string, projectId: string): void {
    if (this.repo.findStore(storeId)?.projectId !== projectId) throw new StoreNotFoundError(storeId);
  }

  private authorizeView(viewId: string, projectId: string): DsView {
    const view = this.repo.findView(viewId);
    const owner = view ? this.repo.findStore(view.storeId) : undefined;
    if (!view || owner?.projectId !== projectId) throw new ViewNotFoundError(viewId);
    return view;
  }

  /** Refuses an insert that would push a store past MAX_ROWS_PER_STORE; nothing is written when it throws. */
  private assertRowCapacity(storeId: string, additionalRows: number): void {
    if (this.repo.countRows(storeId) + additionalRows > MAX_ROWS_PER_STORE) throw new StoreRowCapError(storeId, MAX_ROWS_PER_STORE);
  }

  private requireColumns(storeId: string, columnIds: string[]): DsColumn[] {
    const columns = this.repo.listColumns(storeId);
    this.assertKnownColumns(columns, columnIds);
    return columns;
  }

  private assertKnownColumns(columns: DsColumn[], columnIds: string[]): void {
    const known = new Set(columns.map((column) => column.id));
    const unknown = columnIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new UnknownColumnError(unknown);
  }

  /** Parses a raw view config and checks its size, its column references and the kanban group-by rule; returns the parsed config. */
  private validatedConfig(storeId: string, viewType: ViewType, rawConfig: unknown): DsViewConfig {
    const parsed = DsViewConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw new InvalidViewConfigError('Invalid view config');
    const config = parsed.data;
    if (Buffer.byteLength(JSON.stringify(config), 'utf8') > MAX_VIEW_CONFIG_BYTES) throw new InvalidViewConfigError('View config is too large');
    this.requireColumns(storeId, [
      ...(config.where ?? []).map((clause) => clause.columnId),
      ...(config.orderBy ?? []).map((term) => term.columnId),
      ...(config.groupByColumnId ? [config.groupByColumnId] : []),
    ]);
    this.assertValidGroupByColumn(storeId, viewType, config);
    return config;
  }

  /** A kanban view is unreadable without a group-by column that is a select column of its own store; other view types don't care. */
  private assertValidGroupByColumn(storeId: string, viewType: ViewType, config: DsViewConfig): void {
    if (viewType !== 'kanban') return;
    const groupByColumn = config.groupByColumnId ? this.repo.listColumns(storeId).find((column) => column.id === config.groupByColumnId) : undefined;
    if (groupByColumn?.columnType !== 'select') throw new InvalidViewConfigError('A kanban view\'s groupByColumnId must be a select column of the same store');
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

  private daemonSetColumns(columns: DsColumn[]): DsColumn[] {
    return columns.filter((column) => column.autoValue !== undefined);
  }

  /** Replaces whatever the caller sent for a daemon-set column by the daemon's clock. */
  private withDaemonSetCells(daemonSetColumns: DsColumn[], cells: Record<string, unknown>, at: string): Record<string, unknown> {
    const stamps = Object.fromEntries(daemonSetColumns.map((column) => [column.id, at]));
    return { ...cells, ...stamps };
  }

  private refuseDaemonSetCells(storeId: string, patch: Record<string, unknown>): void {
    const patchedColumn = this.daemonSetColumns(this.repo.listColumns(storeId)).find((column) => patch[column.id] !== undefined);
    if (patchedColumn) throw new DaemonSetColumnError(`Column ${patchedColumn.id} is set by the daemon and cannot be updated`);
  }

  /** Checks every non-undefined cell against its column type; an `undefined` cell is no change and is skipped. */
  private validateCells(columns: DsColumn[], cells: Record<string, unknown>): void {
    this.assertKnownColumns(columns, Object.keys(cells));
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

    // ponytail: in-memory filter; push down to SQL if stores grow past the MAX_ROWS_PER_STORE cap
    const filtered = this.repo.listRows(storeId).filter((row) =>
      where.data.every((clause) => matches(columnById.get(clause.columnId)!, row.data[clause.columnId] ?? null, clause)));
    const sorted = filtered.sort((a, b) => {
      for (const { columnId, dir } of orderBy.data) {
        const [cellA, cellB] = [a.data[columnId], b.data[columnId]];
        if (isEmptyCell(cellA) !== isEmptyCell(cellB)) return isEmptyCell(cellA) ? 1 : -1;
        const order = compareCells(columnById.get(columnId)!, cellA, cellB);
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
    try {
      return runInTransaction(this.db, BATCH_SAVEPOINT, work);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
}
