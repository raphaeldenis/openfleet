import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  COLUMN_TYPES, COLUMN_TYPE_BY_FORMAT, ColumnFormatSchema, DsViewConfigSchema, MANAGER_LOG_KINDS, MAX_SELECT_OPTIONS, NO_VALUE_GROUP_ID, orderedKanbanOptions, OrderTermSchema, SelectOptionSchema, VIEW_TYPES, WhereClauseSchema,
  type AutoValue, type ColumnChanges, type ColumnWrap, type ColumnFormat, type ColumnType, type DataStore, type DsColumn, type DsRow, type DsView, type DsViewConfig, type OptionReplacement, type OrderTerm, type SelectOption, type ViewType, type WhereClause,
} from '@openfleet/shared';
import { z } from 'zod';
import { inTransaction as runInTransaction } from '../db/transaction.js';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError, type ColumnMetadata, type DataStoreRepository, type RowActor } from './dataStoreRepository.js';
import { rowGuardViolationOf } from './rowGuard.js';

export { DoneWithoutPrUrlError, JournalShortenedError, RowGuardViolationError } from './rowGuard.js';

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
export class ColumnIsNaturalKeyError extends ConstraintError {
  constructor(columnName: string) {
    super(`Column "${columnName}" is the natural key of the data store; clear the natural key first`);
  }
}
export class ColumnUsedByViewError extends ConstraintError {
  constructor(columnName: string, viewName: string) {
    super(`Column "${columnName}" is used by the view "${viewName}"; update or delete the view first`);
  }
}
export class ColumnIsDisplayColumnError extends ConstraintError {
  constructor(columnName: string, labelledColumnName: string) {
    super(`Column "${columnName}" is the display column of "${labelledColumnName}"; clear that display column first`);
  }
}
export class OptionsHeldByRowsError extends ConstraintError {
  constructor(optionIds: string[]) {
    super(`Rows still hold the options being removed (${optionIds.join(', ')}); change those rows first`);
  }
}
export class ColumnOrderMismatchError extends InvalidColumnDefinitionError {
  constructor(diff: { missingIds: string[]; unknownIds: string[]; repeatedIds: string[] }) {
    super(`column_ids must list every column exactly once; missing: [${diff.missingIds.join(', ')}], unknown: [${diff.unknownIds.join(', ')}], repeated: [${diff.repeatedIds.join(', ')}]`);
  }
}
export class StoreRowCapError extends Error {
  constructor(readonly storeId: string, readonly cap: number) {
    super(`Data store ${storeId} is at its ${cap}-row cap`);
  }
}

/** A write put a `kind` outside the closed list in the log table of a manager. */
export class LogKindNotAllowedError extends Error {
  constructor(readonly kind: unknown) {
    super(`The manager log refuses kind ${JSON.stringify(kind)}. Allowed kinds: ${MANAGER_LOG_KINDS.join(', ')}. Ticket reports go in the ticket journal, not in the log.`);
  }
}

const LOG_KIND_COLUMN_NAME = 'kind';
const isLogKindColumn = (column: DsColumn): boolean => column.displayName.trim().toLowerCase() === LOG_KIND_COLUMN_NAME;
const labelOfSelectedOption = (column: DsColumn, optionId: unknown): unknown => (column.options ?? []).find((option) => option.id === optionId)?.label ?? optionId;
const isPermittedLogKind =(kind: unknown): boolean => (MANAGER_LOG_KINDS as readonly unknown[]).includes(kind);

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
    case 'date': {
      const isDateString = typeof value === 'string' && isIsoDate(value);
      if (!isDateString) return false;
      const needsExplicitOffset = column.format === 'datetime';
      const hasTimeWithExplicitOffset = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
      return !needsExplicitOffset || hasTimeWithExplicitOffset;
    }
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

function viewConfigReferences(config: DsViewConfig, columnId: string): boolean {
  const referencedColumnIds = [
    ...(config.where ?? []).map((clause) => clause.columnId),
    ...(config.orderBy ?? []).map((term) => term.columnId),
    ...(config.cardFields ?? []),
    ...(config.groupByColumnId ? [config.groupByColumnId] : []),
    ...(config.cardTitleColumnId ? [config.cardTitleColumnId] : []),
  ];
  return referencedColumnIds.includes(columnId);
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

  /** Renames a column, replaces the options of a select column, edits its display metadata and sets or clears the store natural key, all or nothing. */
  updateColumn(storeId: string, input: Scope & { columnId: string; changes: ColumnChanges }): DsColumn {
    this.authorize(storeId, input.projectId);
    const { name, options, naturalKey } = input.changes;
    const hasNothingToUpdate = Object.values(input.changes).every((change) => change === undefined);
    if (hasNothingToUpdate) throw new InvalidColumnDefinitionError('Nothing to update: pass name, natural_key, options or a column metadata field');
    const column = this.requireColumn(storeId, input.columnId);
    const displayName = name === undefined ? column.displayName : normalizeName(name);
    const replacedOptions = options === undefined ? column.options : this.replacedOptions(column, options);
    const metadata = this.metadataAfter(storeId, column, input.changes);
    return this.inTransaction(() => {
      if (options !== undefined) this.refuseOptionsStillHeldByRows(storeId, { column, options: replacedOptions });
      const updatedColumn = this.guarded(() => this.repo.updateColumn(storeId, { columnId: column.id, displayName, options: replacedOptions, metadata }));
      if (naturalKey !== undefined) this.applyNaturalKeyChoice(storeId, { projectId: input.projectId, columnId: column.id, isNaturalKey: naturalKey });
      return updatedColumn;
    });
  }

  /** Removes a column and its cells, recording the cleared cells in each row history. The natural key column and columns used by a view stay. */
  deleteColumn(storeId: string, input: Scope & { columnId: string; actor: RowActor }): void {
    this.authorize(storeId, input.projectId);
    const column = this.requireColumn(storeId, input.columnId);
    const isNaturalKey = this.repo.findStore(storeId)?.naturalKeyColumnId === column.id;
    if (isNaturalKey) throw new ColumnIsNaturalKeyError(column.displayName);
    const usingView = this.repo.listViews(storeId).find((view) => viewConfigReferences(view.config, column.id));
    if (usingView) throw new ColumnUsedByViewError(column.displayName, usingView.displayName);
    const labelledColumn = this.repo.listColumns(storeId).find((storeColumn) => storeColumn.displayColumnId === column.id);
    if (labelledColumn) throw new ColumnIsDisplayColumnError(column.displayName, labelledColumn.displayName);
    this.guarded(() => this.repo.deleteColumn(storeId, { columnId: column.id, actor: input.actor, at: this.clock() }));
  }

  /** Gives the columns the order of `columnIds`, which must list every column of the store exactly once. */
  reorderColumns(storeId: string, input: Scope & { columnIds: string[] }): DsColumn[] {
    this.authorize(storeId, input.projectId);
    const storedIds = this.repo.listColumns(storeId).map((column) => column.id);
    const missingIds = storedIds.filter((id) => !input.columnIds.includes(id));
    const unknownIds = input.columnIds.filter((id) => !storedIds.includes(id));
    const repeatedIds = input.columnIds.filter((id, index) => input.columnIds.indexOf(id) !== index);
    const isPermutation = [missingIds, unknownIds, repeatedIds].every((ids) => ids.length === 0);
    if (!isPermutation) throw new ColumnOrderMismatchError({ missingIds, unknownIds, repeatedIds });
    return this.guarded(() => this.repo.reorderColumns(storeId, input.columnIds));
  }

  private requireColumn(storeId: string, columnId: string): DsColumn {
    const column = this.repo.listColumns(storeId).find((storedColumn) => storedColumn.id === columnId);
    if (!column) throw new UnknownColumnError([columnId]);
    return column;
  }

  /** The complete display metadata of a column once `changes` apply: a field left out keeps its value, null clears it. */
  private metadataAfter(storeId: string, column: DsColumn, changes: ColumnChanges): ColumnMetadata {
    const keptOrChanged = <T>(change: T | null | undefined, kept: T | undefined): T | null => change === undefined ? kept ?? null : change;
    const format = keptOrChanged(changes.format, column.format);
    const isFormatOfAnotherType = format !== null && COLUMN_TYPE_BY_FORMAT[format] !== column.columnType;
    if (isFormatOfAnotherType) throw new InvalidColumnDefinitionError('The format must match the column type');
    const config = keptOrChanged(changes.config, column.config);
    const isConfigOnNonNumber = changes.config != null && column.columnType !== 'number';
    if (isConfigOnNonNumber) throw new InvalidColumnDefinitionError('Only a number column takes a config');
    const displayColumnId = keptOrChanged(changes.displayColumnId, column.displayColumnId);
    if (displayColumnId !== null) this.requireDisplayColumn(storeId, { column, displayColumnId });
    return {
      required: changes.required ?? column.required === true,
      format,
      config: config !== null && Object.keys(config).length === 0 ? null : config,
      displayColumnId,
      displayWidth: keptOrChanged(changes.displayWidth, column.displayWidth),
      wrap: this.wrapAfter(column, changes.wrap),
    };
  }

  private wrapAfter(column: DsColumn, change: ColumnChanges['wrap']): ColumnWrap | null {
    if (change === undefined) return column.wrap ?? null;
    if (change.mode === 'truncate') return null;
    return change.maxLines === undefined ? { mode: 'wrap' } : { mode: 'wrap', maxLines: change.maxLines };
  }

  private requireDisplayColumn(storeId: string, input: { column: DsColumn; displayColumnId: string }): void {
    if (input.displayColumnId === input.column.id) throw new InvalidColumnDefinitionError('A column cannot be its own display column');
    const isInStore = this.repo.listColumns(storeId).some((storeColumn) => storeColumn.id === input.displayColumnId);
    if (!isInStore) throw new UnknownColumnError([input.displayColumnId]);
    const displayColumnIdOf = new Map(this.repo.listColumns(storeId).map((storeColumn) => [storeColumn.id, storeColumn.displayColumnId]));
    const visited = new Set<string>();
    for (let followed = input.displayColumnId as string | undefined; followed !== undefined; followed = displayColumnIdOf.get(followed)) {
      const closesCycle = followed === input.column.id;
      if (closesCycle) throw new InvalidColumnDefinitionError('A display column cannot lead back to the column: this closes a cycle of display columns');
      const isInsideAnExistingCycle = visited.has(followed);
      if (isInsideAnExistingCycle) throw new InvalidColumnDefinitionError('A display column cannot lead into a cycle of display columns');
      visited.add(followed);
    }
  }

  /** Keeps the id of every replacement matching a current option (by id, else by label); a replacement matching none gets a fresh id. The list is authoritative: labels and colors come from the replacements only. */
  private replacedOptions(column: DsColumn, replacements: OptionReplacement[]): SelectOption[] {
    if (column.columnType !== 'select') throw new InvalidColumnDefinitionError('Only a select column takes options; a column cannot change type');
    const currentOptions = column.options ?? [];
    const options = replacements.map((replacement) => {
      const keptOption = replacement.id === undefined
        ? currentOptions.find((option) => option.label === replacement.label)
        : currentOptions.find((option) => option.id === replacement.id);
      const claimsForeignId = replacement.id !== undefined && keptOption === undefined;
      if (claimsForeignId) throw new InvalidColumnDefinitionError(`Option id ${replacement.id} does not belong to this column`);
      return { ...replacement, id: keptOption?.id ?? this.newId() };
    });
    const lowercaseLabels = options.map((option) => option.label.toLowerCase());
    const hasDuplicateLabels = new Set(lowercaseLabels).size !== lowercaseLabels.length;
    if (hasDuplicateLabels) throw new InvalidColumnDefinitionError('Option labels must be unique, whatever their case');
    return this.validateColumnDefinition(column.columnType, options)!;
  }

  private refuseOptionsStillHeldByRows(storeId: string, input: { column: DsColumn; options: SelectOption[] | null }): void {
    if (input.column.columnType !== 'select') return;
    const keptIds = new Set((input.options ?? []).map((option) => option.id));
    const heldIds = this.repo.listRows(storeId).map((row) => row.data[input.column.id]);
    const removedIdsHeld = [...new Set(heldIds.filter((id): id is string => typeof id === 'string' && !keptIds.has(id)))];
    if (removedIdsHeld.length > 0) throw new OptionsHeldByRowsError(removedIdsHeld);
  }

  private applyNaturalKeyChoice(storeId: string, input: Scope & { columnId: string; isNaturalKey: boolean }): void {
    if (input.isNaturalKey) return this.setNaturalKey(storeId, input);
    const isCurrentKey = this.repo.findStore(storeId)?.naturalKeyColumnId === input.columnId;
    if (isCurrentKey) this.setNaturalKey(storeId, { projectId: input.projectId, columnId: null });
  }

  addColumn(storeId: string, input: Scope & { displayName: string; columnType: ColumnType; format?: ColumnFormat; options?: SelectOption[]; autoValue?: AutoValue }): DsColumn {
    this.authorize(storeId, input.projectId);
    const displayName = normalizeName(input.displayName);
    const options = this.validateColumnDefinition(input.columnType, input.options);
    if (input.format !== undefined) {
      const parsedFormat = ColumnFormatSchema.safeParse(input.format);
      const isCompatibleFormat = parsedFormat.success && COLUMN_TYPE_BY_FORMAT[parsedFormat.data] === input.columnType;
      if (!isCompatibleFormat) throw new InvalidColumnDefinitionError('The format must match the column type');
    }
    const isDaemonSetOnNonDate = input.autoValue !== undefined && input.columnType !== 'date';
    if (isDaemonSetOnNonDate) throw new InvalidColumnDefinitionError('Only a date column can take an auto_value');
    return this.guarded(() => this.repo.addColumn(storeId, {
      id: this.newId(), displayName, columnType: input.columnType, format: input.format, ...(options ? { options } : {}), autoValue: input.autoValue, at: this.clock(),
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
    this.refuseKindOutsideManagerLogList(storeId, columns, data);
    this.assertRowCapacity(storeId, 1);
    return this.inTransaction(() => {
      const rowId = this.newId();
      this.refuseNaturalKeyHeldByAnotherRow(storeId, rowId, data);
      return this.repo.insertRow(storeId, { id: rowId, data, actor: input.actor, at });
    });
  }

  updateRow(storeId: string, rowId: string, input: Scope & { patch: Record<string, unknown>; actor: RowActor }): DsRow {
    this.authorize(storeId, input.projectId);
    this.refuseDaemonSetCells(storeId, input.patch);
    const columns = this.repo.listColumns(storeId);
    this.validateCells(columns, input.patch);
    this.refuseKindOutsideManagerLogList(storeId, columns, input.patch);
    this.refuseNaturalKeyHeldByAnotherRow(storeId, rowId, input.patch);
    this.refuseRowGuardViolation(storeId, rowId, input);
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
    for (const { data } of stampedRows) {
      this.validateCells(columns, data);
      this.refuseKindOutsideManagerLogList(storeId, columns, data);
    }
    this.assertRowCapacity(storeId, input.items.length);
    return this.inTransaction(() => stampedRows.map(({ data, at }) => {
      const rowId = this.newId();
      this.refuseNaturalKeyHeldByAnotherRow(storeId, rowId, data);
      return this.repo.insertRow(storeId, { id: rowId, data, actor: input.actor, at });
    }));
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

  /**
   * In the log table of a manager, a written `kind` cell must be one of MANAGER_LOG_KINDS (exact, case-sensitive match).
   * The column is found by its display name, ignoring case and surrounding spaces; in a select column the option label is compared, not the option id.
   * Other tables, logs without a `kind` column and writes that leave the kind cell out or null are not concerned; stored rows are never rewritten.
   */
  private refuseKindOutsideManagerLogList(storeId: string, columns: DsColumn[], cells: Record<string, unknown>): void {
    const kindColumn = columns.find(isLogKindColumn);
    const writtenCell = kindColumn === undefined ? undefined : cells[kindColumn.id];
    const writesNoKind = writtenCell === undefined || writtenCell === null;
    if (kindColumn === undefined || writesNoKind) return;
    const writtenKind = kindColumn.columnType === 'select' ? labelOfSelectedOption(kindColumn, writtenCell) : writtenCell;
    if (isPermittedLogKind(writtenKind)) return;
    const isManagerLog = this.db.prepare('SELECT 1 FROM managers WHERE log_store_id = ?').get(storeId) !== undefined;
    if (isManagerLog) throw new LogKindNotAllowedError(writtenKind);
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
      this.refuseKindOutsideManagerLogList(storeId, columns, patch);
    }
    return this.inTransaction(() => input.items.map(({ rowId, patch }) => {
      this.refuseNaturalKeyHeldByAnotherRow(storeId, rowId, patch);
      this.refuseRowGuardViolation(storeId, rowId, { projectId: input.projectId, patch });
      return this.repo.updateRow(rowId, { storeId, patch, actor: input.actor, at: this.clock() });
    }));
  }

  /** When the project guards its rows, refuses a patch that shortens the journal or moves a row to done without a pr_url. */
  private refuseRowGuardViolation(storeId: string, rowId: string, input: Scope & { patch: Record<string, unknown> }): void {
    if (!this.repo.isRowGuardEnabled(input.projectId)) return;
    const current = this.repo.findRow(rowId, storeId);
    if (current === undefined) return;
    const violation = rowGuardViolationOf({ columns: this.repo.listColumns(storeId), current, patch: input.patch });
    if (violation !== undefined) throw violation;
  }

  query(storeId: string, input: Scope & { where?: WhereClause[]; orderBy?: OrderTerm[]; limit?: number }): DsRow[] {
    this.authorize(storeId, input.projectId);
    return this.runQuery(storeId, input);
  }

  pageRows(storeId: string, input: Scope & { limit: number; offset: number }): { rows: DsRow[]; totalRowCount: number } {
    this.authorize(storeId, input.projectId);
    return this.guarded(() => this.repo.pageRows(storeId, input));
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

  /** Returns ordered option buckets, including empty ones; ungrouped rows require explicit opt-in. */
  kanbanGroups(viewId: string, input: Scope): KanbanGroup[] {
    const view = this.authorizeView(viewId, input.projectId);

    const groupBy = this.repo.listColumns(view.storeId).find((column) => column.id === view.config.groupByColumnId);
    if (groupBy?.columnType !== 'select') throw new InvalidViewConfigError('The kanban group-by column must be a select column');

    const rows = this.runQuery(view.storeId, { where: view.config.where, orderBy: view.config.orderBy });
    const options = orderedKanbanOptions({ options: groupBy.options ?? [], columnOrder: view.config.columnOrder });
    const groups = options.map((option) => ({ option, rows: rows.filter((row) => row.data[groupBy.id] === option.id) }));
    if (view.config.showUngrouped !== true) return groups;
    const knownOptionIds: ReadonlySet<unknown> = new Set(options.map((option) => option.id));
    const ungroupedRows = rows.filter((row) => !knownOptionIds.has(row.data[groupBy.id]));
    if (ungroupedRows.length === 0) return groups;
    return [...groups, { option: { id: NO_VALUE_GROUP_ID, label: 'No value' }, rows: ungroupedRows }];
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
      ...(config.cardTitleColumnId ? [config.cardTitleColumnId] : []),
      ...(config.cardFields ?? []),
    ]);
    this.assertValidGroupByColumn(storeId, viewType, config);
    this.assertValidColumnOrder(storeId, config);
    return config;
  }

  private assertValidColumnOrder(storeId: string, config: DsViewConfig): void {
    if (config.columnOrder === undefined) return;
    const groupColumn = this.repo.listColumns(storeId).find((column) => column.id === config.groupByColumnId);
    if (groupColumn?.columnType !== 'select') throw new InvalidViewConfigError('columnOrder requires a select group-by column');
    const knownOptionIds = new Set((groupColumn.options ?? []).map((option) => option.id));
    const hasUnknownOption = config.columnOrder.some((id) => !knownOptionIds.has(id));
    if (hasUnknownOption) throw new InvalidViewConfigError('columnOrder must reference options of the group-by column');
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
    const parsed = z.array(SelectOptionSchema).min(1).max(MAX_SELECT_OPTIONS).safeParse(options);
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
