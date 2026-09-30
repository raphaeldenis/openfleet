import type { DataStore, ManagerView, DsColumn, DsRow, DsRowHistoryEntry, DsView, Session, WorkingState } from '@openfleet/shared';

/** A session as an agent needs it to act: identity, where it runs, lifecycle state and model, without the settings it supplied itself. */
export const sessionView = (session: Session) => ({
  id: session.id, name: session.name, emoji: session.emoji, directory: session.directory, state: session.state, stateSince: session.stateSince,
  model: session.model, resolvedModel: session.resolvedModel, modelDriftedFrom: session.modelDriftedFrom,
  role: session.role, worktree: session.worktree, branch: session.branch, exitCode: session.exitCode, closedAt: session.closedAt,
});

/** A session inside a lineage listing, where the parent link is what places it in the tree. */
export const lineageSessionView = (session: Session) => ({ ...sessionView(session), parentId: session.parentId });

export const storeView = (store: DataStore) => ({ id: store.id, displayName: store.displayName });

export const columnView = (column: DsColumn) => ({
  id: column.id, displayName: column.displayName, columnType: column.columnType,
  ...(column.options ? { options: column.options } : {}),
  ...(column.autoValue ? { autoValue: column.autoValue } : {}),
});

export interface RowProjection {
  /** The column ids a row keeps, in order; undefined keeps the whole row. */
  columnIds?: string[];
  includeUpdatedAt: boolean;
}

/** A row as an object keyed by column id, limited to the projected columns. */
export const rowView = (row: DsRow, { columnIds, includeUpdatedAt }: RowProjection) => ({
  id: row.id,
  data: columnIds ? Object.fromEntries(columnIds.filter((columnId) => columnId in row.data).map((columnId) => [columnId, row.data[columnId]])) : row.data,
  ...(includeUpdatedAt ? { updatedAt: row.updatedAt } : {}),
});

/** A row as `[rowId, updatedAt?, ...one cell per column id]`, an empty cell being null; the result header names every one of these positions. */
export const columnarRowView = (row: DsRow, { columnIds, includeUpdatedAt }: Required<RowProjection>) => [
  row.id,
  ...(includeUpdatedAt ? [row.updatedAt] : []),
  ...columnIds.map((columnId) => row.data[columnId] ?? null),
];

export const rowChangeView = (entry: DsRowHistoryEntry) => ({
  actorKind: entry.actorKind, actorLabel: entry.actorLabel, change: entry.change, createdAt: entry.createdAt,
});

export const savedView = (view: DsView) => ({ id: view.id, displayName: view.displayName, viewType: view.viewType, config: view.config });

export const workingStateView = ({ sessionId: _sessionId, ...state }: WorkingState) => state;

/** The manager record the caller reads about itself, without its own session id. */
export const managerView = ({ sessionId: _sessionId, ...record }: ManagerView) => record;
