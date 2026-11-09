import { MAX_STEP_OUTPUT_BYTES } from '@openfleet/shared';
import { log } from '../logger.js';
import { InvalidCellValueError, StoreRowCapError, type DataStoreService } from '../stores/dataStoreService.js';
import { StoreNotFoundError, UnknownColumnError, type RowActor } from '../stores/dataStoreRepository.js';
import type { ResolvedStoreRead, ResolvedStoreWrite } from './storeCellTemplates.js';

/** The part of the data store service the store cells use; every call carries the project of the playbook, which the service checks against the owner of the table. */
export type PlaybookStores = Pick<DataStoreService, 'query' | 'saveRow' | 'listColumns'>;

/** A store step answers the fields a later step may read, or only the code of its failure: a failure never carries a row, a value or the text of an error. */
export type StoreOutcome = { kind: 'done'; output: Record<string, unknown> } | { kind: 'failed'; code: string };

export const MAX_READ_OUTPUT_CHARS = MAX_STEP_OUTPUT_BYTES;

/** The history of a table names who wrote a row: the run, by its id. The kind is `trigger`, the automation kind the history accepts. */
const playbookRunActor = (runId: string): RowActor => ({ kind: 'trigger', label: `playbook run ${runId}` });

type StoreStepFailure = 'store_read_failed' | 'store_write_failed';

const failureCodeOf = (error: unknown, otherwise: StoreStepFailure): string => {
  if (error instanceof StoreNotFoundError) return 'store_not_in_project';
  if (error instanceof UnknownColumnError) return 'store_column_unknown';
  if (error instanceof InvalidCellValueError) return 'store_value_rejected';
  if (error instanceof StoreRowCapError) return 'store_row_cap_reached';
  log('warn', 'a playbook store step failed', { errorType: error instanceof Error ? error.constructor.name : typeof error });
  return otherwise;
};

/** Reads the rows of a table of the project, at most `request.limit` of them; refuses an answer longer than MAX_READ_OUTPUT_CHARS rather than cut it. */
export function readStoreRows({ stores, projectId, request }: { stores: PlaybookStores; projectId: string; request: ResolvedStoreRead }): StoreOutcome {
  try {
    const { storeId, columnIds, where, orderBy, limit } = request;
    if (columnIds !== undefined) {
      const knownColumnIds = new Set(stores.listColumns(storeId, { projectId }).map((column) => column.id));
      const unknownColumnIds = columnIds.filter((columnId) => !knownColumnIds.has(columnId));
      if (unknownColumnIds.length > 0) throw new UnknownColumnError(unknownColumnIds);
    }
    const rows = stores.query(storeId, { projectId, where, orderBy, limit });
    const kept = (data: Record<string, unknown>) => (columnIds === undefined ? data : Object.fromEntries(columnIds.filter((columnId) => columnId in data).map((columnId) => [columnId, data[columnId]])));
    const output = JSON.stringify(rows.map((row) => ({ id: row.id, data: kept(row.data) })));
    const isTooLarge = output.length > MAX_READ_OUTPUT_CHARS;
    return isTooLarge ? { kind: 'failed', code: 'store_read_too_large' } : { kind: 'done', output: { rowCount: rows.length, output } };
  } catch (error) {
    return { kind: 'failed', code: failureCodeOf(error, 'store_read_failed') };
  }
}

/** Writes one row into a table of the project as the run: an upsert on the natural key when the cell names one, an insert otherwise. Every value goes through `mask` first. */
export function writeStoreRow({ stores, projectId, runId, request, mask }: {
  stores: PlaybookStores; projectId: string; runId: string; request: ResolvedStoreWrite; mask: (value: string) => string;
}): StoreOutcome {
  try {
    const data = Object.fromEntries(Object.entries(request.cells).map(([columnId, value]) => [columnId, mask(value)]));
    const mode = request.naturalKeyColumnId === undefined ? 'create' : 'upsert';
    const { outcome, row } = stores.saveRow(request.storeId, { projectId, actor: playbookRunActor(runId), data, mode });
    return { kind: 'done', output: { outcome, rowId: row.id } };
  } catch (error) {
    return { kind: 'failed', code: failureCodeOf(error, 'store_write_failed') };
  }
}
