import { AutoValueSchema, ColumnTypeSchema, OrderTermSchema, SelectOptionSchema, WhereClauseSchema, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RowNotFoundError, StoreNotFoundError, type DataStoreRepository, type RowActor } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import { fail, guarded, truncateToByteBudget } from './toolResults.js';
import { columnView, rowView, storeView } from './toolViews.js';

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

  function requireProject(): { projectId: string } | undefined {
    return caller.projectId ? { projectId: caller.projectId } : undefined;
  }

  server.registerTool('create_data_store', {
    description: 'Create a new data store (table) in your project',
    inputSchema: { display_name: z.string().min(1) },
  }, async ({ display_name }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => storeView(stores.createStore({ ...scope, displayName: display_name })));
  });

  server.registerTool('describe_data_store', {
    description: 'A data store\'s id, display name, and its columns in order (id, displayName, columnType, options when a select column, autoValue when set)',
    inputSchema: { store: z.string().min(1) },
  }, async ({ store }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const dataStore = storeRepo.findStore(store);
      if (!dataStore || dataStore.projectId !== scope.projectId) throw new StoreNotFoundError(store);
      return { ...storeView(dataStore), columns: storeRepo.listColumns(store).map(columnView) };
    });
  });

  server.registerTool('add_data_store_column', {
    description: 'Add a typed column to a data store; a select column needs at least one option; auto_value "created_at" (date column only) makes the daemon fill the column with its own clock at insert and refuse any update',
    inputSchema: { store: z.string().min(1), display_name: z.string().min(1), column_type: ColumnTypeSchema, options: z.array(SelectOptionSchema).optional(), auto_value: AutoValueSchema.optional() },
  }, async ({ store, display_name, column_type, options, auto_value }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => columnView(stores.addColumn(store, { ...scope, displayName: display_name, columnType: column_type, options, autoValue: auto_value })));
  });

  server.registerTool('insert_data_store_rows', {
    description: `Insert up to ${MAX_BATCH_ROWS} rows in one all-or-nothing batch; each row is keyed by column id. Returns the inserted row ids and a count, not the rows themselves`,
    inputSchema: { store: z.string().min(1), rows: z.array(z.record(z.string(), z.unknown())).max(MAX_BATCH_ROWS) },
  }, async ({ store, rows }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const ignored = stores.ignoredDaemonSetColumnIds(store, { ...scope, items: rows });
      const inserted = stores.insertRows(store, { ...scope, items: rows, actor: agentActor(caller) });
      return { ids: inserted.map((row) => row.id), count: inserted.length, ...(ignored.length > 0 ? { ignored } : {}) };
    });
  });

  server.registerTool('update_data_store_rows', {
    description: `Patch up to ${MAX_BATCH_ROWS} rows in one all-or-nothing batch. Returns the patched row ids and a count, not the rows themselves`,
    inputSchema: {
      store: z.string().min(1),
      updates: z.array(z.object({ row_id: z.string().min(1), patch: z.record(z.string(), z.unknown()) })).max(MAX_BATCH_ROWS),
    },
  }, async ({ store, updates }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    const items = updates.map(({ row_id, patch }) => ({ rowId: row_id, patch }));
    return guarded(() => {
      const updated = stores.updateRows(store, { ...scope, items, actor: agentActor(caller) });
      return { ids: updated.map((row) => row.id), count: updated.length };
    });
  });

  server.registerTool('delete_data_store_row', {
    description: 'Delete a row, keeping its change history as a tombstone',
    inputSchema: { row_id: z.string().min(1) },
  }, async ({ row_id }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const storeId = storeRepo.findRowStoreId(row_id);
      const owningStore = storeId ? storeRepo.findStore(storeId) : undefined;
      if (!storeId || owningStore?.projectId !== scope.projectId) throw new RowNotFoundError(row_id);
      stores.deleteRow(storeId, row_id, { ...scope, actor: agentActor(caller) });
      return { deleted: row_id };
    });
  });

  server.registerTool('query_data_store', {
    description: `Filter, sort and limit a store's rows (limit ≤ ${MAX_QUERY_LIMIT}, default ${DEFAULT_QUERY_LIMIT}); the result is also cut off past ${MAX_QUERY_RESULT_BYTES} bytes, with \`truncated: true\` when that happened`,
    inputSchema: {
      store: z.string().min(1),
      where: z.array(WhereClauseSchema).optional(),
      order_by: z.array(OrderTermSchema).optional(),
      limit: z.number().int().min(0).max(MAX_QUERY_LIMIT).optional(),
    },
  }, async ({ store, where, order_by, limit }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const rows = stores.query(store, { ...scope, where, orderBy: order_by, limit: limit ?? DEFAULT_QUERY_LIMIT });
      const { items, truncated } = truncateToByteBudget(rows.map(rowView), MAX_QUERY_RESULT_BYTES);
      return { rows: items, truncated, count: items.length };
    });
  });
}
