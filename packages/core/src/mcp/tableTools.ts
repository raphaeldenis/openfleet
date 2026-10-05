import { AutoValueSchema, ColumnTypeSchema, SelectOptionSchema, type DataStore, type DsColumn, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RowNotFoundError, StoreNotFoundError, UnknownColumnReferenceError, type DataStoreRepository, type RowActor } from '../stores/dataStoreRepository.js';
import { InvalidColumnDefinitionError, SAVE_MODES, type DataStoreService } from '../stores/dataStoreService.js';
import { guardedFor, refusalReasonOf, refuse, truncateToByteBudget } from './toolResults.js';
import { cellsKeyedByColumnId, coerceFilterValue, columnLookupFor, requireColumn } from './rowValues.js';
import { writeRowByRow, type RowBatchReport } from './rowBatch.js';
import { AggregateSchema, aggregatedRows } from './queryAggregation.js';
import { orderTermsOf, QueryOrderTermSchema, QueryWhereClauseSchema, whereClausesOf } from './queryArguments.js';
import { cellReaderFor, columnarRowView, columnView, rowView, storeView } from './toolViews.js';

// Task 15 caps (see the plan's Review Focus #3 and Lead amendment on P3-T11): a batch write is capped so
// one call can't hold the outer transaction open indefinitely, and a query defaults to a page an agent can
// actually read rather than dumping a whole store.
const MAX_BATCH_ROWS = 500;
const MAX_QUERY_LIMIT = 1000;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_RESULT_BYTES = 1024 * 1024;

export interface RegisterTableToolsDeps {
  stores: DataStoreService;
  storeRepo: DataStoreRepository;
  caller: Session;
}

const agentActor = (caller: Session): RowActor => ({ kind: 'agent', label: `${caller.emoji} ${caller.name}` });

export function registerTableTools(server: McpServer, deps: RegisterTableToolsDeps): void {
  const { stores, storeRepo, caller } = deps;
  const guarded = guardedFor(caller);

  function requireProject(): { projectId: string } | undefined {
    return caller.projectId ? { projectId: caller.projectId } : undefined;
  }

  /** The caller's own store a reference names, by id or else by display name; a foreign or missing store reads the same. */
  function ownStoreOf(reference: string, scope: { projectId: string }): DataStore {
    const storeWithThatId = storeRepo.findStore(reference);
    const store = storeWithThatId?.projectId === scope.projectId ? storeWithThatId : storeRepo.findStoreByName(scope.projectId, reference);
    if (!store) throw new StoreNotFoundError(reference);
    return store;
  }

  server.registerTool('create_data_store', {
    description: 'Create a new data store (table) in your project',
    inputSchema: { display_name: z.string().min(1) },
  }, async ({ display_name }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => storeView(stores.createStore({ ...scope, displayName: display_name })));
  });

  server.registerTool('describe_data_store', {
    description: 'A data store\'s id, display name, and its columns in order (id, displayName, columnType, options when a select column, autoValue when set)',
    inputSchema: { store: z.string().min(1) },
  }, async ({ store }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const dataStore = ownStoreOf(store, scope);
      return { ...storeView(dataStore), columns: storeRepo.listColumns(dataStore.id).map(columnView) };
    });
  });

  server.registerTool('add_data_store_column', {
    description: 'Add a typed column to a data store; natural_key true (text column only) makes it the column whose value names a row for update_data_store_row key; a select column needs at least one option; auto_value "created_at" (date column only) makes the daemon fill the column with its own clock at insert and refuse any update',
    inputSchema: { store: z.string().min(1), display_name: z.string().min(1), column_type: ColumnTypeSchema, options: z.array(SelectOptionSchema).optional(), auto_value: AutoValueSchema.optional(), natural_key: z.boolean().optional() },
  }, async ({ store, display_name, column_type, options, auto_value, natural_key }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const isNaturalKeyOnNonText = natural_key === true && column_type !== 'text';
      if (isNaturalKeyOnNonText) throw new InvalidColumnDefinitionError('The natural key must be a text column of this data store');
      const column = stores.addColumn(store, { ...scope, displayName: display_name, columnType: column_type, options, autoValue: auto_value });
      if (natural_key === true) stores.setNaturalKey(store, { ...scope, columnId: column.id });
      return columnView(column);
    });
  });

  server.registerTool('set_data_store_natural_key', {
    description: 'Make a text column the natural key of a data store (store is its id or display name, column an id or display name in any case), or clear the key with column null. '
      + 'The natural key names a row: insert_data_store_rows modes create, upsert and update collide on it, update_data_store_row finds a row by key, and no two rows may hold the same value. '
      + 'Refused when the column is not text or when rows already share a value in it. Returns the store with its naturalKeyColumnId',
    inputSchema: { store: z.string().min(1), column: z.string().min(1).nullable() },
  }, async ({ store, column }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const ownStore = ownStoreOf(store, scope);
      const columnId = column === null ? null : requireColumn(storeRepo.listColumns(ownStore.id), column).id;
      stores.setNaturalKey(ownStore.id, { ...scope, columnId });
      return storeView(storeRepo.findStore(ownStore.id)!);
    });
  });

  server.registerTool('insert_data_store_rows', {
    description: `Insert up to ${MAX_BATCH_ROWS} rows. store is its id or display name; each row is an object keyed by column id or display name (any case; a name shared by two columns is refused as ambiguous, use the id). `
      + 'A numeric string is read as a number; a select cell takes an option label (any case) or id, an unknown option is refused with the valid ones. '
      + 'mode says what a natural key collision does: "create" (default) fails the colliding row and leaves the existing row untouched, "upsert" inserts or overwrites the supplied columns, "update" overwrites only and fails an absent key; '
      + 'a store with no natural key inserts plainly in create and upsert, and refuses update. '
      + 'Each row is written on its own: a bad row fails alone, the good rows commit, and all the values of a row land or none. '
      + 'Returns {inserted, updated, failed, failures: ["row N: reason"] (N counts from 1), mode, ids (inserted row ids), updatedRowIDs, count}, not the rows themselves',
    inputSchema: { store: z.string().min(1), rows: z.array(z.record(z.string(), z.unknown())).max(MAX_BATCH_ROWS), mode: z.enum(SAVE_MODES).optional() },
  }, async ({ store, rows, mode }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    const saveMode = mode ?? 'create';
    return guarded(() => {
      const ownStore = ownStoreOf(store, scope);
      const isUpdateWithoutNaturalKey = saveMode === 'update' && ownStore.naturalKeyColumnId === undefined;
      if (isUpdateWithoutNaturalKey) throw new InvalidColumnDefinitionError('The data store has no natural key, so mode "update" cannot find rows; set one with set_data_store_natural_key');
      const columns = storeRepo.listColumns(ownStore.id);
      const ignoredColumnIds = new Set<string>();
      const report = writeRowByRow(rows, {
        write: (row) => {
          const cells = cellsKeyedByColumnId(columns, row);
          const { outcome, row: written } = stores.saveRow(ownStore.id, { ...scope, data: cells, actor: agentActor(caller), mode: saveMode });
          stores.ignoredDaemonSetColumnIds(ownStore.id, { ...scope, items: [cells] }).forEach((columnId) => ignoredColumnIds.add(columnId));
          return { outcome, rowId: written.id };
        },
        rejectionReasonOf: refusalReasonOf,
      });
      const ignored = [...ignoredColumnIds];
      return {
        inserted: report.insertedRowIDs.length, updated: report.updatedRowIDs.length, failed: report.failures.length, failures: report.failures, mode: saveMode,
        ids: report.insertedRowIDs, updatedRowIDs: report.updatedRowIDs, count: report.insertedRowIDs.length + report.updatedRowIDs.length,
        ...(ignored.length > 0 ? { ignored } : {}),
      };
    });
  });

  server.registerTool('update_data_store_rows', {
    description: 'Change cells of many rows, in exactly ONE of two modes per call. store is its id or display name; cells are keyed by column id or display name (any case), a numeric string is read as a number, a select cell takes an option label (any case) or id. '
      + `LIST mode: updates [{row_id, values}] (up to ${MAX_BATCH_ROWS}; patch is accepted in place of values); each update is written on its own, a bad one fails alone and the others commit. `
      + 'FILTER mode: where {column: value, ...} and set {column: value, ...}; every row matching all the where equalities (ANDed; a select matches by option label or id, null matches an empty cell) gets the set cells. '
      + 'FILTER mode is all-or-nothing: an unknown column or an invalid value refuses the whole call, a failing write undoes the others, and matching no row succeeds with matched 0. '
      + 'A natural key value another row holds is refused, and so is setting the natural key through a filter matching several rows. '
      + 'Returns {updated, failed, failures: ["row N: reason"], updatedRowIDs, matched (filter mode), ids, count}, not the rows themselves',
    inputSchema: {
      store: z.string().min(1),
      updates: z.array(z.object({ row_id: z.string().min(1), values: z.record(z.string(), z.unknown()).optional(), patch: z.record(z.string(), z.unknown()).optional() })).max(MAX_BATCH_ROWS).optional(),
      where: z.record(z.string(), z.unknown()).optional(),
      set: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({ store, updates, where, set }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    const isListMode = updates !== undefined && where === undefined && set === undefined;
    const isFilterMode = updates === undefined && where !== undefined && set !== undefined;
    if (!isListMode && !isFilterMode) return refuse('invalid_body', 'pass exactly one mode: updates (list mode), or where together with set (filter mode)');
    return guarded(() => {
      const ownStore = ownStoreOf(store, scope);
      const report = isListMode ? updateRowsByIds(ownStore, scope, updates) : updateRowsByFilter(ownStore, scope, { where: where!, set: set! });
      return {
        updated: report.updatedRowIDs.length, failed: report.failures.length, failures: report.failures, updatedRowIDs: report.updatedRowIDs,
        ...(report.matched === undefined ? {} : { matched: report.matched }),
        ids: report.updatedRowIDs, count: report.updatedRowIDs.length,
      };
    });
  });

  server.registerTool('update_data_store_row', {
    description: 'Change cells of one row, addressed by exactly one of row_id (every queried row carries its id) or key (the value of the store\'s natural key column, see describe_data_store). '
      + 'store is its id or display name. values is keyed by column id or display name (any case); a select cell takes an option label (any case) or id. '
      + 'All-or-nothing: an unknown column or an invalid value changes nothing. Returns the id of the row',
    inputSchema: { store: z.string().min(1), row_id: z.string().min(1).optional(), key: z.string().min(1).optional(), values: z.record(z.string(), z.unknown()) },
  }, async ({ store, row_id, key, values }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    const isAddressedByExactlyOne = (row_id === undefined) !== (key === undefined);
    if (!isAddressedByExactlyOne) return refuse('invalid_body', 'pass exactly one of row_id or key');
    if (Object.keys(values).length === 0) return refuse('invalid_body', 'values must name at least one column');
    return guarded(() => {
      const ownStore = ownStoreOf(store, scope);
      const rowId = row_id ?? stores.findRowByNaturalKey(ownStore.id, { ...scope, key: key! }).id;
      const patch = cellsKeyedByColumnId(storeRepo.listColumns(ownStore.id), values);
      const [updated] = stores.updateRows(ownStore.id, { ...scope, items: [{ rowId, patch }], actor: agentActor(caller) });
      return { id: updated!.id };
    });
  });

  server.registerTool('delete_data_store_row', {
    description: 'Delete a row, keeping its change history as a tombstone',
    inputSchema: { row_id: z.string().min(1) },
  }, async ({ row_id }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const storeId = storeRepo.findRowStoreId(row_id);
      const owningStore = storeId ? storeRepo.findStore(storeId) : undefined;
      if (!storeId || owningStore?.projectId !== scope.projectId) throw new RowNotFoundError(row_id);
      stores.deleteRow(storeId, row_id, { ...scope, actor: agentActor(caller) });
      return { deleted: row_id };
    });
  });

  server.registerTool('query_data_store', {
    description: `Filter, sort and limit a store's rows (limit ≤ ${MAX_QUERY_LIMIT}, default ${DEFAULT_QUERY_LIMIT}); the result is also cut off past ${MAX_QUERY_RESULT_BYTES} bytes, with \`truncated: true\` when that happened. `
      + 'By default each row is {id, data keyed by column id, updatedAt}. format "columnar" returns {columns, names, rows: [[rowId, updatedAt, ...one cell per data column]], truncated, count} instead (an empty cell is null): '
      + 'columns lists id, updatedAt (unless dropped) then the data column ids, names labels the same positions, so columns[k] and names[k] describe row[k]. '
      + 'columns (ids or display names, names match case-insensitively) keeps only those data columns in both formats: names resolve to ids, an id wins over a name, duplicates are dropped, order is preserved, and an empty list keeps NO data columns (columnar rows are [rowId, updatedAt] or [rowId] with include_updated_at false, rows format has data: {}); '
      + 'select is another name for columns (pass one of them). store is its id or display name. '
      + 'where [{column, op, value}] and order_by [{column, dir}] name a column by id or display name (any case; columnId stays accepted); op is eq, ne (or neq), gt, gte, lt, lte, contains, or in (value is a list). '
      + 'A select column compares by option label (any case) or id, a numeric string is read as a number, and a select cell is returned as its option label. '
      + 'group_by [column, ...] and aggregates [{op, column?, as?}] return one row per group instead of the rows: {group columns by display name, then each aggregate under its alias} '
      + '(op count, sum, avg, min, max; count without column counts the rows, count with a column its non-empty cells; sum and avg need a number column; the alias defaults to count or op_ColumnName; with no aggregate the rows are counted; limit caps the groups; not combinable with format, select or columns). '
      + 'include_updated_at false drops updatedAt from every row. Unknown arguments are ignored',
    inputSchema: {
      store: z.string().min(1),
      where: z.array(QueryWhereClauseSchema).optional(),
      order_by: z.array(QueryOrderTermSchema).optional(),
      limit: z.number().int().min(0).max(MAX_QUERY_LIMIT).optional(),
      format: z.enum(['rows', 'columnar']).optional(),
      columns: z.array(z.string().min(1)).optional(),
      select: z.array(z.string().min(1)).optional(),
      group_by: z.array(z.string().min(1)).optional(),
      aggregates: z.array(AggregateSchema).optional(),
      include_updated_at: z.boolean().optional(),
    },
  }, async ({ store, where, order_by, limit, format, columns, select, group_by, aggregates, include_updated_at }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    if (columns !== undefined && select !== undefined) return refuse('invalid_body', 'pass either select or columns, not both');
    const requestedColumns = columns ?? select;
    const isAggregation = group_by !== undefined || aggregates !== undefined;
    const shapesRowsItself = format !== undefined || requestedColumns !== undefined;
    if (isAggregation && shapesRowsItself) return refuse('invalid_body', 'group_by and aggregates return one row per group, so they cannot be combined with format, select or columns');
    return guarded(() => {
      const ownStore = ownStoreOf(store, scope);
      const storeColumns = storeRepo.listColumns(ownStore.id);
      const cellOf = cellReaderFor(storeColumns);
      const rows = stores.query(ownStore.id, {
        ...scope, where: whereClausesOf(storeColumns, where ?? []), orderBy: orderTermsOf(storeColumns, order_by ?? []), limit: isAggregation ? undefined : limit ?? DEFAULT_QUERY_LIMIT,
      });
      if (isAggregation) {
        const groups = aggregatedRows({ columns: storeColumns, rows, groupBy: group_by ?? [], aggregates: aggregates ?? [], cellOf }).slice(0, limit ?? DEFAULT_QUERY_LIMIT);
        const { items, truncated } = truncateToByteBudget(groups, MAX_QUERY_RESULT_BYTES);
        return { rows: items, truncated, count: items.length };
      }
      const includeUpdatedAt = include_updated_at ?? true;
      const isColumnar = format === 'columnar';
      if (isColumnar) {
        const dataColumns = resolveColumns(ownStore.id, requestedColumns);
        const columnIds = dataColumns.map((column) => column.id);
        const leadingHeaders = includeUpdatedAt ? ['id', 'updatedAt'] : ['id'];
        const header = { columns: [...leadingHeaders, ...columnIds], names: [...leadingHeaders, ...dataColumns.map((column) => column.displayName)] };
        const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...header, rows: [], truncated: false, count: rows.length }), 'utf8');
        const columnarRows = rows.map((row) => columnarRowView(row, { columnIds, includeUpdatedAt, cellOf }));
        const { items, truncated } = truncateToByteBudget(columnarRows, MAX_QUERY_RESULT_BYTES - envelopeBytes, { bytesBetweenItems: 1 });
        return { ...header, rows: items, truncated, count: items.length };
      }
      const columnIds = requestedColumns ? resolveColumns(ownStore.id, requestedColumns).map((column) => column.id) : undefined;
      const { items, truncated } = truncateToByteBudget(rows.map((row) => rowView(row, { columnIds, includeUpdatedAt, cellOf })), MAX_QUERY_RESULT_BYTES);
      return { rows: items, truncated, count: items.length };
    });
  });

  function updateRowsByIds(ownStore: DataStore, scope: { projectId: string }, updates: { row_id: string; values?: Record<string, unknown> | undefined; patch?: Record<string, unknown> | undefined }[]): RowBatchReport & { matched?: number } {
    const columns = storeRepo.listColumns(ownStore.id);
    return writeRowByRow(updates, {
      write: ({ row_id, values, patch }) => {
        const cells = cellsKeyedByColumnId(columns, values ?? patch ?? {});
        const [updated] = stores.updateRows(ownStore.id, { ...scope, items: [{ rowId: row_id, patch: cells }], actor: agentActor(caller) });
        return { outcome: 'updated', rowId: updated!.id };
      },
      rejectionReasonOf: refusalReasonOf,
    });
  }

  function updateRowsByFilter(ownStore: DataStore, scope: { projectId: string }, { where, set }: { where: Record<string, unknown>; set: Record<string, unknown> }): RowBatchReport & { matched: number } {
    const columns = storeRepo.listColumns(ownStore.id);
    const whereClauses = Object.entries(where).map(([reference, value]) => {
      const column = requireColumn(columns, reference);
      return { columnId: column.id, op: 'eq' as const, value: coerceFilterValue(column, value) };
    });
    const { matched, updated } = stores.updateRowsWhere(ownStore.id, { ...scope, where: whereClauses, set: cellsKeyedByColumnId(columns, set), actor: agentActor(caller) });
    return { insertedRowIDs: [], updatedRowIDs: updated.map((row) => row.id), failures: [], matched };
  }

  /** Turns requested column references (an id, else a display name in any case) into de-duplicated store columns; every store column when none are requested. */
  function resolveColumns(storeId: string, requested: string[] | undefined): DsColumn[] {
    const storeColumns = storeRepo.listColumns(storeId);
    if (!requested) return storeColumns;
    const columnFor = columnLookupFor(storeColumns);
    const unknownReferences = requested.filter((reference) => !columnFor(reference));
    if (unknownReferences.length > 0) throw new UnknownColumnReferenceError(unknownReferences);
    return [...new Set(requested.map((reference) => columnFor(reference)!))];
  }
}
