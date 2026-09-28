import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ColumnType, DataStore, DsColumn, DsRow, DsRowChange, DsRowHistoryEntry, RowActorKind, SelectOption } from '@openfleet/shared';
import { newId } from '../ids.js';

export interface RowActor { kind: RowActorKind; label: string }

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
const toRow = (r: RowRow): DsRow => ({
  id: r.id, storeId: r.store_id, data: JSON.parse(r.data_json) as Record<string, unknown>, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toHistoryEntry = (r: HistoryRow): DsRowHistoryEntry => ({
  id: r.id, rowId: r.row_id, actorKind: r.actor_kind, actorLabel: r.actor_label,
  change: JSON.parse(r.change_json) as DsRowChange, createdAt: r.created_at,
});

/** Maps each patched column to its `{ from, to }`; columns whose value stays the same are left out. An empty cell reads as null. */
function diffCells(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const change: Record<string, { from: unknown; to: unknown }> = {};
  for (const [columnId, to] of Object.entries(patch)) {
    const from = current[columnId] ?? null;
    const isSameValue = isDeepStrictEqual(from, to);
    if (!isSameValue) change[columnId] = { from, to };
  }
  return change;
}

export class DataStoreRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createStore(input: { id: string; projectId: string; displayName: string; at: string }): DataStore {
    this.db.prepare('INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.projectId, input.displayName, input.at, input.at);
    return { id: input.id, projectId: input.projectId, displayName: input.displayName, createdAt: input.at, updatedAt: input.at };
  }

  addColumn(storeId: string, input: { id: string; displayName: string; columnType: ColumnType; options?: SelectOption[]; at: string }): DsColumn {
    const nextSortOrder = this.listColumns(storeId).length;
    const optionsJson = input.options === undefined ? null : JSON.stringify(input.options);
    this.db.prepare('INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, storeId, input.displayName, input.columnType, optionsJson, nextSortOrder, input.at);
    return { id: input.id, storeId, displayName: input.displayName, columnType: input.columnType, options: input.options ?? null, sortOrder: nextSortOrder };
  }

  listColumns(storeId: string): DsColumn[] {
    const rows = this.db.prepare('SELECT * FROM ds_columns WHERE store_id = ? ORDER BY sort_order, created_at, id').all(storeId) as unknown as ColumnRow[];
    return rows.map(toColumn);
  }

  insertRow(storeId: string, input: { id: string; data: Record<string, unknown>; actor: RowActor; at: string }): DsRow {
    this.inTransaction(() => {
      this.refuseUnknownColumns(storeId, Object.keys(input.data));
      this.db.prepare('INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.id, storeId, JSON.stringify(input.data), input.at, input.at);
      this.recordChange(input.id, { actor: input.actor, at: input.at, change: { kind: 'create' } });
    });
    return { id: input.id, storeId, data: input.data, createdAt: input.at, updatedAt: input.at };
  }

  updateRow(rowId: string, input: { patch: Record<string, unknown>; actor: RowActor; at: string }): DsRow {
    return this.inTransaction(() => {
      const current = this.findRow(rowId);
      if (!current) throw new RowNotFoundError(rowId);
      this.refuseUnknownColumns(current.storeId, Object.keys(input.patch));

      const change = diffCells(current.data, input.patch);
      const changesNothing = Object.keys(change).length === 0;
      if (changesNothing) return current;

      const data = { ...current.data, ...input.patch };
      this.db.prepare('UPDATE ds_rows SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), input.at, rowId);
      this.recordChange(rowId, { actor: input.actor, at: input.at, change });
      return { ...current, data, updatedAt: input.at };
    });
  }

  deleteRow(rowId: string, input: { actor: RowActor; at: string }): void {
    this.inTransaction(() => {
      this.recordChange(rowId, { actor: input.actor, at: input.at, change: { kind: 'delete' } });
      this.db.prepare('DELETE FROM ds_rows WHERE id = ?').run(rowId);
    });
  }

  listRows(storeId: string): DsRow[] {
    const rows = this.db.prepare('SELECT * FROM ds_rows WHERE store_id = ? ORDER BY created_at, rowid').all(storeId) as unknown as RowRow[];
    return rows.map(toRow);
  }

  /** Newest first. Authorizes through the entry's own store, so a deleted row's trail stays readable. */
  rowHistory(rowId: string, scope?: { projectId: string }): DsRowHistoryEntry[] {
    const projectId = scope?.projectId ?? null;
    const entries = this.db.prepare(
      `SELECT history.* FROM ds_row_history history
       JOIN data_stores store ON store.id = history.store_id
       WHERE history.row_id = ? AND (? IS NULL OR store.project_id = ?)
       ORDER BY history.created_at DESC, history.rowid DESC`,
    ).all(rowId, projectId, projectId) as unknown as HistoryRow[];
    return entries.map(toHistoryEntry);
  }

  findStoreByName(projectId: string, displayName: string): DataStore | undefined {
    const store = this.db.prepare('SELECT * FROM data_stores WHERE project_id = ? AND display_name = ? COLLATE NOCASE').get(projectId, displayName) as StoreRow | undefined;
    return store ? toStore(store) : undefined;
  }

  findColumnByName(storeId: string, displayName: string): DsColumn | undefined {
    const column = this.db.prepare('SELECT * FROM ds_columns WHERE store_id = ? AND display_name = ? COLLATE NOCASE').get(storeId, displayName) as ColumnRow | undefined;
    return column ? toColumn(column) : undefined;
  }

  private findRow(rowId: string): DsRow | undefined {
    const row = this.db.prepare('SELECT * FROM ds_rows WHERE id = ?').get(rowId) as RowRow | undefined;
    return row ? toRow(row) : undefined;
  }

  private refuseUnknownColumns(storeId: string, columnIds: string[]): void {
    const knownColumnIds = new Set(this.listColumns(storeId).map((column) => column.id));
    const unknownColumnIds = columnIds.filter((columnId) => !knownColumnIds.has(columnId));
    if (unknownColumnIds.length > 0) throw new UnknownColumnError(unknownColumnIds);
  }

  private recordChange(rowId: string, entry: { actor: RowActor; at: string; change: DsRowChange }): void {
    const { changes: entriesWritten } = this.db.prepare(
      `INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at)
       SELECT ?, store_id, id, ?, ?, ?, ? FROM ds_rows WHERE id = ?`,
    ).run(newId(), entry.actor.kind, entry.actor.label, JSON.stringify(entry.change), entry.at, rowId);
    const rowDoesNotExist = Number(entriesWritten) === 0;
    if (rowDoesNotExist) throw new RowNotFoundError(rowId);
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
