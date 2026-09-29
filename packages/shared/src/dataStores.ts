import { z } from 'zod';

export const COLUMN_TYPES = ['text', 'number', 'date', 'select', 'json'] as const;
export const ColumnTypeSchema = z.enum(COLUMN_TYPES);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export const SelectOptionSchema = z.object({ id: z.string().min(1), label: z.string().min(1) });
export type SelectOption = z.infer<typeof SelectOptionSchema>;

export const AutoValueSchema = z.enum(['created_at']);
export type AutoValue = z.infer<typeof AutoValueSchema>;

export interface DsColumn {
  id: string;
  storeId: string;
  displayName: string;
  columnType: ColumnType;
  options: SelectOption[] | null;
  sortOrder: number;
  autoValue?: AutoValue;
}

export interface DataStore {
  id: string;
  projectId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface DsRow {
  id: string;
  storeId: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const ROW_ACTOR_KINDS = ['human', 'agent', 'trigger'] as const;
export const RowActorKindSchema = z.enum(ROW_ACTOR_KINDS);
export type RowActorKind = z.infer<typeof RowActorKindSchema>;

export type DsRowChange = { kind: 'create' } | { kind: 'delete' } | Record<string, { from: unknown; to: unknown }>;

export interface DsRowHistoryEntry {
  id: string;
  rowId: string;
  actorKind: RowActorKind;
  actorLabel: string;
  change: DsRowChange;
  createdAt: string;
}

export const WHERE_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;

export const WhereClauseSchema = z.object({
  columnId: z.string().min(1),
  op: z.enum(WHERE_OPERATORS),
  value: z.unknown(),
});
export type WhereClause = z.infer<typeof WhereClauseSchema>;

export const OrderTermSchema = z.object({ columnId: z.string().min(1), dir: z.enum(['asc', 'desc']) });
export type OrderTerm = z.infer<typeof OrderTermSchema>;

export const VIEW_TYPES = ['grid', 'kanban'] as const;
export const ViewTypeSchema = z.enum(VIEW_TYPES);
export type ViewType = z.infer<typeof ViewTypeSchema>;

export const DsViewConfigSchema = z.object({
  where: z.array(WhereClauseSchema).optional(),
  orderBy: z.array(OrderTermSchema).optional(),
  groupByColumnId: z.string().min(1).optional(),
});
export type DsViewConfig = z.infer<typeof DsViewConfigSchema>;

export interface DsView {
  id: string;
  storeId: string;
  displayName: string;
  viewType: ViewType;
  config: DsViewConfig;
  sortOrder: number;
}

export interface DataStoreDetail extends DataStore {
  columns: DsColumn[];
}

export const MAX_ROW_BATCH = 500;
export const MAX_HISTORY_LIMIT = 500;

export const MAX_STORE_NAME_CHARS = 200;

export const CreateDataStoreRequestSchema = z.object({ projectId: z.string().min(1), displayName: z.string().min(1).max(MAX_STORE_NAME_CHARS) });
export type CreateDataStoreRequest = z.infer<typeof CreateDataStoreRequestSchema>;

const CellsSchema = z.record(z.string(), z.unknown());

export const InsertRowsRequestSchema = z.object({ projectId: z.string().min(1), rows: z.array(CellsSchema).max(MAX_ROW_BATCH) });
export type InsertRowsRequest = z.infer<typeof InsertRowsRequestSchema>;

export const UpdateRowsRequestSchema = z.object({
  projectId: z.string().min(1),
  updates: z.array(z.object({ rowId: z.string().min(1), patch: CellsSchema })).max(MAX_ROW_BATCH),
});
export type UpdateRowsRequest = z.infer<typeof UpdateRowsRequestSchema>;
