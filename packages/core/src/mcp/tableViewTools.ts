import { DsViewConfigSchema, ViewTypeSchema, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RowNotFoundError, type DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import { fail, guarded, truncateToByteBudget } from './toolResults.js';
import { rowChangeView, savedView } from './toolViews.js';

// Rule 3 of the plan's Task 16: a page an agent can actually read, never a whole trail dump.
const MAX_HISTORY_LIMIT = 500;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_RESULT_BYTES = 1024 * 1024;

export interface RegisterTableViewToolsDeps {
  stores: DataStoreService;
  storeRepo: DataStoreRepository;
  caller: Session;
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
    return guarded(() => savedView(stores.createView(store, { ...scope, displayName: display_name, viewType: view_type, config })));
  });

  server.registerTool('list_data_store_views', {
    description: 'List a data store\'s saved views',
    inputSchema: { store: z.string().min(1) },
  }, async ({ store }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => stores.listViews(store, scope).map(savedView));
  });

  server.registerTool('update_data_store_view', {
    description: 'Replace a saved view\'s whole config (fields you omit are cleared); a kanban view\'s groupByColumnId must stay a select column of the same store',
    inputSchema: { view: z.string().min(1), config: DsViewConfigSchema },
  }, async ({ view, config }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => savedView(stores.updateView(view, { ...scope, config })));
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
      const history = storeRepo.rowHistory(row_id, { projectId: scope.projectId, limit: limit ?? DEFAULT_HISTORY_LIMIT });
      if (history.length === 0) throw new RowNotFoundError(row_id);
      const { items: entries, truncated } = truncateToByteBudget(history, MAX_HISTORY_RESULT_BYTES);
      return { entries: entries.map(rowChangeView), truncated, count: entries.length };
    });
  });
}
