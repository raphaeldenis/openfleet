import { AggregateSchema, ScapeAggregateSchema, AutoValueSchema, ColumnFormatSchema, ColumnTypeSchema, SelectOptionSchema, type Aggregate, type ScapeAggregate, type DataStore, type DsColumn, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RowNotFoundError, StoreNotFoundError, UnknownColumnReferenceError, type DataStoreRepository, type RowActor } from '../stores/dataStoreRepository.js';
import { InvalidColumnDefinitionError, SAVE_MODES, type DataStoreService } from '../stores/dataStoreService.js';
import { guardedFor, refusalReasonOf, refuse } from './toolResults.js';
import { queryPage } from './queryPage.js';
import { cellsKeyedByColumnId, coerceFilterValue, columnLookupFor, requireColumn } from './rowValues.js';
import { writeRowByRow, type RowBatchReport } from './rowBatch.js';
import { aggregatedRows } from './queryAggregation.js';
import { orderTermsOf, QueryOrderTermSchema, QueryWhereClauseSchema, whereClausesOf } from './queryArguments.js';
import { cellReaderFor, columnarRowView, columnView, rowView, storeView } from './toolViews.js';

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
    description: 'Describe a store schema, natural key and rowCount. Without store, discover every store with its schema in the caller project; optional project must be the caller project id.',
    inputSchema: { store: z.string().min(1).optional(), project: z.string().min(1).optional() },
  }, async ({ store, project }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    if (project !== undefined && project !== scope.projectId) return refuse('project_not_found', 'this session cannot describe another project');
    return guarded(() => {
      const describeStore = (dataStore: DataStore) => ({
        ...storeView(dataStore), columns: storeRepo.listColumns(dataStore.id).map(columnView), rowCount: storeRepo.countRows(dataStore.id),
      });
      if (store === undefined) return { stores: storeRepo.listStores(scope.projectId).map(describeStore) };
      return describeStore(ownStoreOf(store, scope));
    });
  });

  server.registerTool('add_data_store_column', {
    description: 'Add a typed column to a data store; optional format is datetime (date, ISO time with explicit offset), longText or url (text), or rank (number). '
      + 'natural_key true (text column only) makes it the column whose value names a row for update_data_store_row key; a select column needs at least one option; auto_value "created_at" (date column only) makes the daemon fill the column with its own clock at insert and refuse any update',
    inputSchema: { store: z.string().min(1), display_name: z.string().min(1), column_type: ColumnTypeSchema, format: ColumnFormatSchema.optional(), options: z.array(SelectOptionSchema).optional(), auto_value: AutoValueSchema.optional(), natural_key: z.boolean().optional() },
  }, async ({ store, display_name, column_type, format, options, auto_value, natural_key }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const isNaturalKeyOnNonText = natural_key === true && column_type !== 'text';
      if (isNaturalKeyOnNonText) throw new InvalidColumnDefinitionError('The natural key must be a text column of this data store');
      const column = stores.addColumn(store, { ...scope, displayName: display_name, columnType: column_type, format, options, autoValue: auto_value });
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
    description: `Filter, sort and page a store's rows (limit ≤ ${MAX_QUERY_LIMIT}, default ${DEFAULT_QUERY_LIMIT}, offset default 0). Returns total matching rows or groups, next_offset for the next page, and truncated when the limit or ${MAX_QUERY_RESULT_BYTES}-byte budget cuts off results. `
      + 'By default each row is {id, data keyed by column id, updatedAt}. format "columnar" returns {columns, names, rows: [[rowId, updatedAt, ...one cell per data column]], truncated, count} instead (an empty cell is null): '
      + 'columns lists id, updatedAt (unless dropped) then the data column ids, names labels the same positions, so columns[k] and names[k] describe row[k]. '
      + 'columns (ids or display names, names match case-insensitively) keeps only those data columns in both formats: names resolve to ids, an id wins over a name, duplicates are dropped, order is preserved, and an empty list keeps NO data columns (columnar rows are [rowId, updatedAt] or [rowId] with include_updated_at false, rows format has data: {}); '
      + 'select accepts column names (another name for columns; pass one) or aggregate objects [{agg:"count", column?, as?}]. store is its id or display name. '
      + 'where [{column, op, value}] and order_by [{column, dir}] name a column by id or display name (any case; columnId stays accepted); op is eq, ne (or neq), gt, gte, lt, lte, contains, or in (value is a list). '
      + 'A select column compares by option label (any case) or id, a numeric string is read as a number, and a select cell is returned as its option label. '
      + 'group_by [column, ...] and aggregates [{op, column?, as?}] return one row per group instead of the rows: {group columns by display name, then each aggregate under its alias} '
      + '(op count, sum, avg, min, max; count without column counts the rows, count with a column its non-empty cells of any type; sum and avg need a number column; min/max need text, number or date; non-finite results are refused; the alias defaults to count or op_ColumnName; with no aggregate the rows are counted; limit and offset page groups; not combinable with format or a column projection). '
      + 'include_updated_at false drops updatedAt from every row. Unknown arguments are ignored',
    inputSchema: {
      store: z.string().min(1),
      where: z.array(QueryWhereClauseSchema).optional(),
      order_by: z.array(QueryOrderTermSchema).optional(),
      limit: z.number().int().min(0).max(MAX_QUERY_LIMIT).optional(),
      offset: z.number().int().min(0).optional(),
      format: z.enum(['rows', 'columnar']).optional(),
      columns: z.array(z.string().min(1)).optional(),
      select: z.union([z.array(z.string().min(1)), z.array(ScapeAggregateSchema)]).optional(),
      group_by: z.array(z.string().min(1)).optional(),
      aggregates: z.array(AggregateSchema).optional(),
      include_updated_at: z.boolean().optional(),
    },
  }, async ({ store, where, order_by, limit, offset, format, columns, select, group_by, aggregates, include_updated_at }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    if (columns !== undefined && select !== undefined) return refuse('invalid_body', 'pass either select or columns, not both');
    const aggregateSelect = select?.filter((entry): entry is ScapeAggregate => typeof entry !== 'string');
    const hasAggregateSelect = aggregateSelect !== undefined && aggregateSelect.length > 0;
    if (hasAggregateSelect && aggregates !== undefined) return refuse('invalid_body', 'pass aggregate select or aggregates, not both');
    const selectedColumns = hasAggregateSelect ? undefined : select as string[] | undefined;
    const requestedColumns = columns ?? selectedColumns;
    const selectedAggregates: Aggregate[] | undefined = hasAggregateSelect ? aggregateSelect.map(({ agg, ...entry }) => ({ op: agg, ...entry })) : aggregates;
    const isAggregation = group_by !== undefined || selectedAggregates !== undefined;
    const shapesRowsItself = format !== undefined || requestedColumns !== undefined;
    if (isAggregation && shapesRowsItself) return refuse('invalid_body', 'group_by and aggregates return one row per group, so they cannot be combined with format, select or columns');
    return guarded(() => {
      const ownStore = ownStoreOf(store, scope);
      const storeColumns = storeRepo.listColumns(ownStore.id);
      const cellOf = cellReaderFor(storeColumns);
      const matchingRows = stores.query(ownStore.id, {
        ...scope, where: whereClausesOf(storeColumns, where ?? []), orderBy: orderTermsOf(storeColumns, order_by ?? []),
      });
      const pageOffset = offset ?? 0;
      const pageLimit = limit ?? DEFAULT_QUERY_LIMIT;
      if (isAggregation) {
        const allGroups = aggregatedRows({ columns: storeColumns, rows: matchingRows, groupBy: group_by ?? [], aggregates: selectedAggregates ?? [], cellOf });
        const groups = allGroups.slice(pageOffset, pageOffset + pageLimit);
        return queryPage({ rows: groups, total: allGroups.length, offset: pageOffset, maxBytes: MAX_QUERY_RESULT_BYTES });
      }
      const rows = matchingRows.slice(pageOffset, pageOffset + pageLimit);
      const includeUpdatedAt = include_updated_at ?? true;
      const isColumnar = format === 'columnar';
      if (isColumnar) {
        const dataColumns = resolveColumns(ownStore.id, requestedColumns);
        const columnIds = dataColumns.map((column) => column.id);
        const leadingHeaders = includeUpdatedAt ? ['id', 'updatedAt'] : ['id'];
        const header = { columns: [...leadingHeaders, ...columnIds], names: [...leadingHeaders, ...dataColumns.map((column) => column.displayName)] };
        const columnarRows = rows.map((row) => columnarRowView(row, { columnIds, includeUpdatedAt, cellOf }));
        return queryPage({ rows: columnarRows, header, total: matchingRows.length, offset: pageOffset, maxBytes: MAX_QUERY_RESULT_BYTES });
      }
      const columnIds = requestedColumns ? resolveColumns(ownStore.id, requestedColumns).map((column) => column.id) : undefined;
      const resultRows = rows.map((row) => rowView(row, { columnIds, includeUpdatedAt, cellOf }));
      return queryPage({ rows: resultRows, total: matchingRows.length, offset: pageOffset, maxBytes: MAX_QUERY_RESULT_BYTES });
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
