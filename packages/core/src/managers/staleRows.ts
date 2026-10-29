import type { DsColumn, DsRow } from '@openfleet/shared';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { toSingleLineName } from './singleLineName.js';

export const STALE_IN_PROGRESS_ROW_MS = 4 * 60 * 60 * 1000;

const EPIC_ID_PREFIX = 'epic-';
const IN_PROGRESS_STATUS = 'inprogress';
const EPIC_KIND = 'epic';
const STATUS_COLUMN_NAMES = ['status'];
const BLOCKED_BY_COLUMN_NAMES = ['blockedby'];
const BOARD_PROGRESS_COLUMN_NAMES = ['step', 'nextaction'];
const ID_COLUMN_NAMES = ['id'];
const KIND_COLUMN_NAMES = ['kind', 'type'];
const EPIC_FLAG_COLUMN_NAMES = ['epic'];
const AFFIRMATIVE_FLAGS = ['true', 'yes', 'y', 'x', '1'];

const normalized = (text: string): string => text.toLowerCase().replace(/[\s_-]+/g, '');

const columnNamed = (columns: readonly DsColumn[], names: readonly string[]): DsColumn | undefined =>
  columns.find((column) => names.includes(normalized(column.displayName)));

const cellText = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

const hasValue = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null;
};

const valueOf = (row: DsRow, column: DsColumn | undefined): unknown => (column ? row.data[column.id] : undefined);

const selectedLabelOf = (column: DsColumn, value: unknown): string => {
  const optionId = cellText(value);
  const option = column.options?.find((candidate) => candidate.id === optionId);
  return option?.label ?? optionId;
};

/** Whether a store looks like a manager board: a status column and a step or next_action column. */
export const isKanbanStore = (columns: readonly DsColumn[]): boolean =>
  columnNamed(columns, STATUS_COLUMN_NAMES) !== undefined && columnNamed(columns, BOARD_PROGRESS_COLUMN_NAMES) !== undefined;

interface StaleRow { label: string; updatedAtMs: number }

const olderFirst = (older: StaleRow, newer: StaleRow): number => older.updatedAtMs - newer.updatedAtMs;

const staleInProgressRowsOf = ({ columns, rows, now }: { columns: readonly DsColumn[]; rows: readonly DsRow[]; now: number }): StaleRow[] => {
  const statusColumn = columnNamed(columns, STATUS_COLUMN_NAMES);
  if (!statusColumn) return [];
  const idColumn = columnNamed(columns, ID_COLUMN_NAMES);
  const blockedByColumn = columnNamed(columns, BLOCKED_BY_COLUMN_NAMES);
  const kindColumn = columnNamed(columns, KIND_COLUMN_NAMES);
  const epicFlagColumn = columnNamed(columns, EPIC_FLAG_COLUMN_NAMES);

  const idOf = (row: DsRow): string => cellText(valueOf(row, idColumn)) || row.id;
  const isInProgress = (row: DsRow) => normalized(selectedLabelOf(statusColumn, row.data[statusColumn.id])) === IN_PROGRESS_STATUS;
  const isBlocked = (row: DsRow) => hasValue(valueOf(row, blockedByColumn));
  const isEpic = (row: DsRow) => {
    const hasEpicPrefix = idOf(row).toLowerCase().startsWith(EPIC_ID_PREFIX);
    const hasEpicKind = kindColumn !== undefined && normalized(cellText(valueOf(row, kindColumn))) === EPIC_KIND;
    const isFlaggedEpic = AFFIRMATIVE_FLAGS.includes(String(valueOf(row, epicFlagColumn)).toLowerCase());
    return hasEpicPrefix || hasEpicKind || isFlaggedEpic;
  };
  const isStale = (row: DsRow) => now - Date.parse(row.updatedAt) > STALE_IN_PROGRESS_ROW_MS;

  return rows
    .filter((row) => isInProgress(row) && isStale(row) && !isEpic(row) && !isBlocked(row))
    .map((row) => ({ label: toSingleLineName(idOf(row)) || row.id, updatedAtMs: Date.parse(row.updatedAt) }))
    .sort(olderFirst);
};

/** The one-line labels of the in progress rows unchanged for more than the stale duration, epics and blocked rows left out, oldest first. */
export const staleInProgressRowLabelsOf = (board: { columns: readonly DsColumn[]; rows: readonly DsRow[]; now: number }): string[] =>
  staleInProgressRowsOf(board).map(({ label }) => label);

/** The stale in progress row labels of every board store of a project, oldest first across the boards. */
export const staleInProgressRowLabelsOfProject = ({ stores, projectId, now }: { stores: Pick<DataStoreRepository, 'listStores' | 'listColumns' | 'listRows'>; projectId: string; now: number }): string[] =>
  stores
    .listStores(projectId)
    .flatMap((store) => {
      const columns = stores.listColumns(store.id);
      if (!isKanbanStore(columns)) return [];
      return staleInProgressRowsOf({ columns, rows: stores.listRows(store.id), now });
    })
    .sort(olderFirst)
    .map(({ label }) => label);
