import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ColumnType, DataStore, DsColumn, DsRow, DsRowChange, DsRowHistoryEntry, DsView, DsViewConfig, RowActorKind, SelectOption, ViewType } from '@openfleet/shared';
import { inTransaction as runInTransaction } from '../db/transaction.js';
import { newId } from '../ids.js';

export interface RowActor { kind: RowActorKind; label: string }

export class StoreNotFoundError extends Error {
  constructor(readonly storeId: string) {
    super(`Data store ${storeId} not found`);
  }
}

export class DuplicateNameError extends Error {
  constructor(readonly displayName: string) {
    super(`The name "${displayName}" is already taken`);
  }
}

export class RowNotFoundError extends Error {
  constructor(readonly rowId: string) {
    super(`Row ${rowId} not found`);
  }
}

export class UnknownColumnError extends Error {
  constructor(readonly columnIds: string[]) {
    super(`Unknown column ids: ${columnIds.join(', ')}`);
  }
}

interface ViewRow { id: string; store_id: string; display_name: string; view_type: ViewType; config_json: string; sort_order: number }
interface StoreRow { id: string; project_id: string; display_name: string; created_at: string; updated_at: string }
interface ColumnRow { id: string; store_id: string; display_name: string; column_type: ColumnType; options_json: string | null; sort_order: number }
interface RowRow { id: string; store_id: string; data_json: string; created_at: string; updated_at: string }
interface HistoryRow { id: string; row_id: string; actor_kind: RowActorKind; actor_label: string; change_json: string; created_at: string }

const toStore = (r: StoreRow): DataStore => ({
  id: r.id, projectId: r.project_id, displayName: r.display_name, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toColumn = (r: ColumnRow): DsColumn => ({
  id: r.id, storeId: r.store_id, displayName: r.display_name, columnType: r.column_type,
  options: r.options_json === null ? null : (JSON.parse(r.options_json) as SelectOption[]), sortOrder: r.sort_order,
});
const toView = (r: ViewRow): DsView => ({
  id: r.id, storeId: r.store_id, displayName: r.display_name, viewType: r.view_type,
  config: JSON.parse(r.config_json) as DsViewConfig, sortOrder: r.sort_order,
});
const toRow = (r: RowRow): DsRow => ({
  id: r.id, storeId: r.store_id, data: JSON.parse(r.data_json) as Record<string, unknown>, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toHistoryEntry = (r: HistoryRow): DsRowHistoryEntry => ({
  id: r.id, rowId: r.row_id, actorKind: r.actor_kind, actorLabel: r.actor_label,
  change: JSON.parse(r.change_json) as DsRowChange, createdAt: r.created_at,
});

const NO_LIMIT = -1;

interface RowHistoryScope { projectId: string; storeId?: string; limit?: number }
const WRITE_SAVEPOINT = 'data_store_write';

/** Round-trips cells through JSON, as SQLite stores them: an `undefined` cell drops out, NaN becomes null, a Date becomes its ISO string, -0 becomes 0. */
const normalizeCells = (cells: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(cells)) as Record<string, unknown>;

/** Maps each patched column to its `{ from, to }`; columns whose value stays the same are left out. An empty cell reads as null. */
function diffCells(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const changedCells = Object.entries(patch).flatMap(([columnId, to]) => {
    const from = Object.hasOwn(current, columnId) ? current[columnId] : null;
    const isSameValue = isDeepStrictEqual(from, to);
    return isSameValue ? [] : [[columnId, { from, to }] as const];
  });
  return Object.fromEntries(changedCells);
}

export class DataStoreRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createStore(input: { id: string; projectId: string; displayName: string; at: string }): DataStore {
    const isNameTaken = this.findStoreByName(input.projectId, input.displayName) !== undefined;
    if (isNameTaken) throw new DuplicateNameError(input.displayName);
    this.db.prepare('INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.projectId, input.displayName, input.at, input.at);
    return { id: input.id, projectId: input.projectId, displayName: input.displayName, createdAt: input.at, updatedAt: input.at };
  }

  addColumn(storeId: string, input: { id: string; displayName: string; columnType: ColumnType; options?: SelectOption[]; at: string }): DsColumn {
    this.refuseMissingStore(storeId);
    const isNameTaken = this.findColumnByName(storeId, input.displayName) !== undefined;
    if (isNameTaken) throw new DuplicateNameError(input.displayName);
    const { columnCount: nextSortOrder } = this.db.prepare('SELECT COUNT(*) AS columnCount FROM ds_columns WHERE store_id = ?').get(storeId) as { columnCount: number };
    const optionsJson = input.options === undefined ? null : JSON.stringify(input.options);
    this.db.prepare('INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, storeId, input.displayName, input.columnType, optionsJson, nextSortOrder, input.at);
    return { id: input.id, storeId, displayName: input.displayName, columnType: input.columnType, options: input.options ?? null, sortOrder: nextSortOrder };
  }

  /** Removes the store with its columns, rows, views and row history (all cascade). */
  deleteStore(id: string): void {
    this.db.prepare('DELETE FROM data_stores WHERE id = ?').run(id);
  }

  insertView(storeId: string, input: { id: string; displayName: string; viewType: ViewType; config: DsViewConfig; at: string }): DsView {
    this.refuseMissingStore(storeId);
    const isNameTaken = this.db.prepare('SELECT 1 FROM ds_views WHERE store_id = ? AND display_name = ? COLLATE NOCASE').get(storeId, input.displayName) !== undefined;
    if (isNameTaken) throw new DuplicateNameError(input.displayName);
    const { viewCount: nextSortOrder } = this.db.prepare('SELECT COUNT(*) AS viewCount FROM ds_views WHERE store_id = ?').get(storeId) as { viewCount: number };
    this.db.prepare('INSERT INTO ds_views (id, store_id, display_name, view_type, config_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, storeId, input.displayName, input.viewType, JSON.stringify(input.config), nextSortOrder, input.at);
    return { id: input.id, storeId, displayName: input.displayName, viewType: input.viewType, config: input.config, sortOrder: nextSortOrder };
  }

  listViews(storeId: string): DsView[] {
    const views = this.db.prepare('SELECT * FROM ds_views WHERE store_id = ? ORDER BY sort_order, created_at, id').all(storeId) as unknown as ViewRow[];
    return views.map(toView);
  }

  findView(id: string): DsView | undefined {
    const view = this.db.prepare('SELECT * FROM ds_views WHERE id = ?').get(id) as ViewRow | undefined;
    return view ? toView(view) : undefined;
  }

  /** Replaces a view's config; the caller (service) has already verified the view exists and is authorized. */
  updateView(id: string, config: DsViewConfig): DsView {
    this.db.prepare('UPDATE ds_views SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    return { ...this.findView(id)!, config };
  }

  deleteView(id: string): void {
    this.db.prepare('DELETE FROM ds_views WHERE id = ?').run(id);
  }

  listColumns(storeId: string): DsColumn[] {
    const rows = this.db.prepare('SELECT * FROM ds_columns WHERE store_id = ? ORDER BY sort_order, created_at, id').all(storeId) as unknown as ColumnRow[];
    return rows.map(toColumn);
  }

  insertRow(storeId: string, input: { id: string; data: Record<string, unknown>; actor: RowActor; at: string }): DsRow {
    const data = normalizeCells(input.data);
    this.inTransaction(() => {
      this.refuseMissingStore(storeId);
      this.refuseUnknownColumns(storeId, Object.keys(data));
      this.db.prepare('INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.id, storeId, JSON.stringify(data), input.at, input.at);
      this.recordChange({ storeId, rowId: input.id, actor: input.actor, at: input.at, change: { kind: 'create' } });
    });
    return { id: input.id, storeId, data, createdAt: input.at, updatedAt: input.at };
  }

  /** An `undefined` cell in the patch means no change; a cell is cleared with an explicit `null`. */
  updateRow(rowId: string, input: { storeId: string; patch: Record<string, unknown>; actor: RowActor; at: string }): DsRow {
    const patch = normalizeCells(input.patch);
    return this.inTransaction(() => {
      const current = this.findRow(rowId, input.storeId);
      if (!current) throw new RowNotFoundError(rowId);
      this.refuseUnknownColumns(input.storeId, Object.keys(patch));

      const change = diffCells(current.data, patch);
      const changesNothing = Object.keys(change).length === 0;
      if (changesNothing) return current;

      const data = { ...current.data, ...patch };
      this.db.prepare('UPDATE ds_rows SET data_json = ?, updated_at = ? WHERE id = ? AND store_id = ?').run(JSON.stringify(data), input.at, rowId, input.storeId);
      this.recordChange({ storeId: input.storeId, rowId, actor: input.actor, at: input.at, change });
      return { ...current, data, updatedAt: input.at };
    });
  }

  deleteRow(rowId: string, input: { storeId: string; actor: RowActor; at: string }): void {
    this.inTransaction(() => {
      this.recordChange({ storeId: input.storeId, rowId, actor: input.actor, at: input.at, change: { kind: 'delete' } });
      this.db.prepare('DELETE FROM ds_rows WHERE id = ? AND store_id = ?').run(rowId, input.storeId);
    });
  }

  listRows(storeId: string): DsRow[] {
    const rows = this.db.prepare('SELECT * FROM ds_rows WHERE store_id = ? ORDER BY created_at, rowid').all(storeId) as unknown as RowRow[];
    return rows.map(toRow);
  }

  countRows(storeId: string): number {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM ds_rows WHERE store_id = ?').get(storeId) as { n: number };
    return n;
  }

  /** Newest first, at most `limit` entries when given. Authorizes through the entry's own store, so a deleted row's trail stays readable. */
  rowHistory(rowId: string, scope: RowHistoryScope): DsRowHistoryEntry[] {
    const entries = this.db.prepare(
      `SELECT history.* FROM ds_row_history history
       JOIN data_stores store ON store.id = history.store_id
       WHERE history.row_id = ? AND store.project_id = ? AND (? IS NULL OR history.store_id = ?)
       ORDER BY history.created_at DESC, history.rowid DESC
       LIMIT ?`,
    ).all(rowId, scope.projectId, scope.storeId ?? null, scope.storeId ?? null, scope.limit ?? NO_LIMIT) as unknown as HistoryRow[];
    return entries.map(toHistoryEntry);
  }

  countRowHistory(rowId: string, scope: RowHistoryScope): number {
    const { n } = this.db.prepare(
      `SELECT COUNT(*) AS n FROM ds_row_history history
       JOIN data_stores store ON store.id = history.store_id
       WHERE history.row_id = ? AND store.project_id = ? AND (? IS NULL OR history.store_id = ?)`,
    ).get(rowId, scope.projectId, scope.storeId ?? null, scope.storeId ?? null) as { n: number };
    return n;
  }

  findStore(id: string): DataStore | undefined {
    const store = this.db.prepare('SELECT * FROM data_stores WHERE id = ?').get(id) as StoreRow | undefined;
    return store ? toStore(store) : undefined;
  }

  listStores(projectId: string): DataStore[] {
    const stores = this.db.prepare('SELECT * FROM data_stores WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as unknown as StoreRow[];
    return stores.map(toStore);
  }

  findStoreByName(projectId: string, displayName: string): DataStore | undefined {
    const store = this.db.prepare('SELECT * FROM data_stores WHERE project_id = ? AND display_name = ? COLLATE NOCASE').get(projectId, displayName) as StoreRow | undefined;
    return store ? toStore(store) : undefined;
  }

  findColumnByName(storeId: string, displayName: string): DsColumn | undefined {
    const column = this.db.prepare('SELECT * FROM ds_columns WHERE store_id = ? AND display_name = ? COLLATE NOCASE').get(storeId, displayName) as ColumnRow | undefined;
    return column ? toColumn(column) : undefined;
  }

  private findRow(rowId: string, storeId: string): DsRow | undefined {
    const row = this.db.prepare('SELECT * FROM ds_rows WHERE id = ? AND store_id = ?').get(rowId, storeId) as RowRow | undefined;
    return row ? toRow(row) : undefined;
  }

  /** The store id owning a row, without parsing its data — enough to authorize before touching the row itself. */
  findRowStoreId(rowId: string): string | undefined {
    const row = this.db.prepare('SELECT store_id FROM ds_rows WHERE id = ?').get(rowId) as { store_id: string } | undefined;
    return row?.store_id;
  }

  private refuseMissingStore(storeId: string): void {
    if (!this.findStore(storeId)) throw new StoreNotFoundError(storeId);
  }

  private refuseUnknownColumns(storeId: string, columnIds: string[]): void {
    const knownColumns = this.db.prepare('SELECT id FROM ds_columns WHERE store_id = ?').all(storeId) as unknown as { id: string }[];
    const knownColumnIds = new Set(knownColumns.map((column) => column.id));
    const unknownColumnIds = columnIds.filter((columnId) => !knownColumnIds.has(columnId));
    if (unknownColumnIds.length > 0) throw new UnknownColumnError(unknownColumnIds);
  }

  private recordChange(entry: { storeId: string; rowId: string; actor: RowActor; at: string; change: DsRowChange }): void {
    const { changes: entriesWritten } = this.db.prepare(
      `INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at)
       SELECT ?, store_id, id, ?, ?, ?, ? FROM ds_rows WHERE id = ? AND store_id = ?`,
    ).run(newId(), entry.actor.kind, entry.actor.label, JSON.stringify(entry.change), entry.at, entry.rowId, entry.storeId);
    const rowDoesNotExist = Number(entriesWritten) === 0;
    if (rowDoesNotExist) throw new RowNotFoundError(entry.rowId);
  }

  /** Runs `work` atomically: a transaction of its own, or a savepoint when the caller already holds one. */
  private inTransaction<T>(work: () => T): T {
    return runInTransaction(this.db, WRITE_SAVEPOINT, work);
  }
}
