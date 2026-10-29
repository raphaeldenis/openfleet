import * as z from 'zod';

export const COLUMN_TYPES = ['text', 'number', 'date', 'select', 'json'] as const;
export const ColumnTypeSchema = z.enum(COLUMN_TYPES);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export const COLUMN_FORMATS = ['datetime', 'longText', 'url', 'rank'] as const;
export const ColumnFormatSchema = z.enum(COLUMN_FORMATS);
export type ColumnFormat = z.infer<typeof ColumnFormatSchema>;
export const COLUMN_TYPE_BY_FORMAT: Record<ColumnFormat, ColumnType> = {
  datetime: 'date', longText: 'text', url: 'text', rank: 'number',
};

export const AGGREGATE_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export const AggregateSchema = z.object({ op: z.enum(AGGREGATE_OPS), column: z.string().min(1).optional(), as: z.string().min(1).optional() });
export const ScapeAggregateSchema = AggregateSchema.omit({ op: true }).extend({ agg: AggregateSchema.shape.op });
export type Aggregate = z.infer<typeof AggregateSchema>;
export type ScapeAggregate = z.infer<typeof ScapeAggregateSchema>;

export const MAX_SELECT_OPTIONS = 500;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const OptionColorSchema = z.string().regex(HEX_COLOR, 'A color is #RGB, #RRGGBB or #RRGGBBAA');

export const SelectOptionSchema = z.object({ id: z.string().min(1), label: z.string().min(1), color: OptionColorSchema.optional() });
export type SelectOption = z.infer<typeof SelectOptionSchema>;

export const AutoValueSchema = z.enum(['created_at']);
export type AutoValue = z.infer<typeof AutoValueSchema>;

export const MIN_DISPLAY_WIDTH = 60;
export const MAX_DISPLAY_WIDTH = 1200;
export const DisplayWidthSchema = z.number().int().min(MIN_DISPLAY_WIDTH).max(MAX_DISPLAY_WIDTH);

export const MAX_WRAP_LINES = 100;
export const WRAP_MODES = ['wrap', 'truncate'] as const;
export const WrapModeSchema = z.enum(WRAP_MODES);
export type WrapMode = z.infer<typeof WrapModeSchema>;
export const WrapMaxLinesSchema = z.number().int().min(1).max(MAX_WRAP_LINES);

/** How a cell wraps; a column that truncates carries no wrap at all. */
export interface ColumnWrap { mode: 'wrap'; maxLines?: number }

export const ColumnConfigSchema = z.object({
  symbol: z.string().max(8).optional(),
  decimals: z.number().int().min(0).max(10).optional(),
  ratingMax: z.number().int().min(1).max(10).optional(),
  ratingIcon: z.string().max(32).optional(),
}).strict();
export type ColumnConfig = z.infer<typeof ColumnConfigSchema>;

export interface DsColumn {
  id: string;
  storeId: string;
  displayName: string;
  columnType: ColumnType;
  format?: ColumnFormat;
  options: SelectOption[] | null;
  sortOrder: number;
  autoValue?: AutoValue;
  /** Present (true) only for a required column; absent means optional. */
  required?: true;
  /** Another column of the same store that labels this one. */
  displayColumnId?: string;
  config?: ColumnConfig;
  displayWidth?: number;
  wrap?: ColumnWrap;
}

export interface DataStore {
  id: string;
  projectId: string;
  displayName: string;
  /** The text column whose value names a row, when the store has one. */
  naturalKeyColumnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DsRow {
  id: string;
  storeId: string;
  data: Record<string, unknown>;
  /** Starts at 1 and rises by one with each write that changes a cell; a writer sends it back as `expectedRev` to refuse a stale write. */
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export const ROW_ACTOR_KINDS = ['human', 'agent', 'trigger'] as const;
export const RowActorKindSchema = z.enum(ROW_ACTOR_KINDS);
export type RowActorKind = z.infer<typeof RowActorKindSchema>;

export type DsRowChange = { kind: 'create' } | { kind: 'delete' } | Record<string, { from: unknown; to: unknown }>;

export const ROW_CHANGE_KINDS = ['insert', 'update', 'delete'] as const;
export const RowChangeKindSchema = z.enum(ROW_CHANGE_KINDS);
export type RowChangeKind = z.infer<typeof RowChangeKindSchema>;

export const ROW_CHANGE_ORDERS = ['desc', 'asc'] as const;
export const RowChangeOrderSchema = z.enum(ROW_CHANGE_ORDERS);
export type RowChangeOrder = z.infer<typeof RowChangeOrderSchema>;

export interface DsRowHistoryEntry {
  /** Stable position in the whole history: never renumbered, never reused, increasing with each recorded change. */
  seq: number;
  id: string;
  rowId: string;
  actorKind: RowActorKind;
  actorLabel: string;
  change: DsRowChange;
  createdAt: string;
}

export const WHERE_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;

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

const UniqueIdsSchema = z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique');

export const DsViewConfigSchema = z.object({
  where: z.array(WhereClauseSchema).optional(),
  orderBy: z.array(OrderTermSchema).optional(),
  groupByColumnId: z.string().min(1).optional(),
  cardTitleColumnId: z.string().min(1).optional(),
  cardFields: UniqueIdsSchema.optional(),
  columnOrder: UniqueIdsSchema.optional(),
  showUngrouped: z.boolean().optional(),
});
export type DsViewConfig = z.infer<typeof DsViewConfigSchema>;

export const NO_VALUE_GROUP_ID = '__no_value__';

export function orderedKanbanOptions(input: { options: SelectOption[]; columnOrder?: string[] }): SelectOption[] {
  const optionsById = new Map(input.options.map((option) => [option.id, option]));
  const orderedIds = new Set(input.columnOrder ?? []);
  const orderedOptions = [...orderedIds].flatMap((id) => {
    const option = optionsById.get(id);
    return option ? [option] : [];
  });
  const remainingOptions = input.options.filter((option) => !orderedIds.has(option.id));
  return [...orderedOptions, ...remainingOptions];
}

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

export const OptionReplacementSchema = SelectOptionSchema.partial({ id: true }).strict();
export type OptionReplacement = z.infer<typeof OptionReplacementSchema>;

const ColumnWrapChangeSchema = z.object({ mode: WrapModeSchema, maxLines: WrapMaxLinesSchema.optional() }).strict()
  .refine((wrap) => wrap.mode === 'wrap' || wrap.maxLines === undefined, 'maxLines only applies to the wrap mode');

/** A null clears the field; an absent key leaves it unchanged. wrap mode truncate resets the wrapping. */
export const ColumnChangesSchema = z.object({
  name: z.string().trim().min(1).max(MAX_STORE_NAME_CHARS).optional(),
  naturalKey: z.boolean().optional(),
  options: z.array(OptionReplacementSchema).max(MAX_SELECT_OPTIONS).optional(),
  required: z.boolean().optional(),
  displayColumnId: z.string().min(1).nullable().optional(),
  format: ColumnFormatSchema.nullable().optional(),
  config: ColumnConfigSchema.nullable().optional(),
  displayWidth: DisplayWidthSchema.nullable().optional(),
  wrap: ColumnWrapChangeSchema.optional(),
}).strict();
export type ColumnChanges = z.infer<typeof ColumnChangesSchema>;

export const UpdateColumnRequestSchema = ColumnChangesSchema.extend({ projectId: z.string().min(1) });
export type UpdateColumnRequest = z.infer<typeof UpdateColumnRequestSchema>;

export const ReorderColumnsRequestSchema = z.object({ projectId: z.string().min(1), columnIds: z.array(z.string().min(1)) });
export type ReorderColumnsRequest = z.infer<typeof ReorderColumnsRequestSchema>;

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
