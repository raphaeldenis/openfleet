import { DsViewConfigSchema, ViewTypeSchema, type DsViewConfig, type Session, type ViewType } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RowNotFoundError, StoreNotFoundError, type DataStoreRepository } from '../stores/dataStoreRepository.js';
import { InvalidViewConfigError, ViewNotFoundError, type DataStoreService } from '../stores/dataStoreService.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

// Rule 3 of the plan's Task 16: a page an agent can actually read, never a whole trail dump.
const MAX_HISTORY_LIMIT = 500;
const DEFAULT_HISTORY_LIMIT = 100;

export interface RegisterTableViewToolsDeps {
  stores: DataStoreService;
  storeRepo: DataStoreRepository;
  caller: Session;
}

/** Maps any typed service/repository error to a non-throwing `fail()`; a resource outside the caller's project reads identically to one that never existed. */
function guarded<T>(work: () => T) {
  try {
    return ok(work());
  } catch (error) {
    if (error instanceof StoreNotFoundError) return fail('data store not found');
    if (error instanceof ViewNotFoundError) return fail('view not found');
    if (error instanceof RowNotFoundError) return fail('row not found');
    if (error instanceof Error) return fail(error.message);
    throw error;
  }
}

/** A kanban view is unreadable without a group-by column that is a select column of its own store; other view types don't care. */
function assertKanbanGroupIsSelectColumn(storeRepo: DataStoreRepository, storeId: string, viewType: ViewType, config: DsViewConfig): void {
  if (viewType !== 'kanban') return;
  const groupByColumn = config.groupByColumnId
    ? storeRepo.listColumns(storeId).find((column) => column.id === config.groupByColumnId)
    : undefined;
  if (groupByColumn?.columnType !== 'select') throw new InvalidViewConfigError('A kanban view\'s groupByColumnId must reference a select column of the same store');
}

export function registerTableViewTools(server: McpServer, deps: RegisterTableViewToolsDeps): void {
  const { stores, storeRepo, caller } = deps;

  function requireProject(): { projectId: string } | undefined {
    return caller.projectId ? { projectId: caller.projectId } : undefined;
  }

  server.registerTool('create_data_store_view', {
    description: 'Create a saved view (grid or kanban) over a data store; a kanban view\'s groupByColumnId must be a select column of the same store',
    inputSchema: { store: z.string().min(1), display_name: z.string().min(1), view_type: ViewTypeSchema, config: DsViewConfigSchema.optional() },
  }, async ({ store, display_name, view_type, config }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const owningStore = storeRepo.findStore(store);
      if (!owningStore || owningStore.projectId !== scope.projectId) throw new StoreNotFoundError(store);
      assertKanbanGroupIsSelectColumn(storeRepo, store, view_type, config ?? {});
      return stores.createView(store, { ...scope, displayName: display_name, viewType: view_type, config });
    });
  });

  server.registerTool('list_data_store_views', {
    description: 'List a data store\'s saved views',
    inputSchema: { store: z.string().min(1) },
  }, async ({ store }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => stores.listViews(store, scope));
  });

  server.registerTool('update_data_store_view', {
    description: 'Replace a saved view\'s config; a kanban view\'s groupByColumnId must stay a select column of the same store',
    inputSchema: { view: z.string().min(1), config: DsViewConfigSchema },
  }, async ({ view, config }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const existing = storeRepo.findView(view);
      const owner = existing ? storeRepo.findStore(existing.storeId) : undefined;
      if (!existing || owner?.projectId !== scope.projectId) throw new ViewNotFoundError(view);
      assertKanbanGroupIsSelectColumn(storeRepo, existing.storeId, existing.viewType, config);
      return stores.updateView(view, { ...scope, config });
    });
  });

  server.registerTool('delete_data_store_view', {
    description: 'Delete a saved view',
    inputSchema: { view: z.string().min(1) },
  }, async ({ view }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      stores.deleteView(view, scope);
      return { deleted: view };
    });
  });

  server.registerTool('list_row_changes', {
    description: `A row's change history, newest first (limit ≤ ${MAX_HISTORY_LIMIT}, default ${DEFAULT_HISTORY_LIMIT}); a deleted row's history stays readable in its own project`,
    inputSchema: { row_id: z.string().min(1), limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional() },
  }, async ({ row_id, limit }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const storeId = storeRepo.findRowStoreId(row_id);
      if (storeId && storeRepo.findStore(storeId)?.projectId !== scope.projectId) throw new RowNotFoundError(row_id);
      const entries = storeRepo.rowHistory(row_id, { projectId: scope.projectId, limit: limit ?? DEFAULT_HISTORY_LIMIT });
      if (entries.length === 0) throw new RowNotFoundError(row_id);
      return { entries, count: entries.length };
    });
  });
}
