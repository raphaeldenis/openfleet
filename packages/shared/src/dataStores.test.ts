import { describe, expect, it } from 'vitest';
import {
  COLUMN_TYPES,
  ColumnTypeSchema,
  DsViewConfigSchema,
  OrderTermSchema,
  RowActorKindSchema,
  SelectOptionSchema,
  ViewTypeSchema,
  WhereClauseSchema,
  type DsColumn,
  type DsRow,
  type DsRowChange,
  type DsRowHistoryEntry,
  type DsView,
} from './dataStores.js';

describe('ColumnTypeSchema', () => {
  it('accepts the five column types', () => {
    expect(COLUMN_TYPES).toEqual(['text', 'number', 'date', 'select', 'json']);
    COLUMN_TYPES.forEach((columnType) => expect(ColumnTypeSchema.parse(columnType)).toBe(columnType));
  });

  it('rejects a type no column supports', () => {
    expect(() => ColumnTypeSchema.parse('session')).toThrow();
  });
});

describe('SelectOptionSchema', () => {
  it('accepts an option with an id and a label', () => {
    expect(SelectOptionSchema.parse({ id: 'todo', label: 'To do' })).toEqual({ id: 'todo', label: 'To do' });
  });

  it('rejects an option with an empty id', () => {
    expect(() => SelectOptionSchema.parse({ id: '', label: 'To do' })).toThrow();
  });

  it('rejects an option with an empty label', () => {
    expect(() => SelectOptionSchema.parse({ id: 'todo', label: '' })).toThrow();
  });
});

describe('WhereClauseSchema', () => {
  it('accepts every comparison operator', () => {
    const operators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
    operators.forEach((op) => expect(WhereClauseSchema.parse({ columnId: 'c1', op, value: 1 }).op).toBe(op));
  });

  it('rejects an operator outside the supported set', () => {
    expect(() => WhereClauseSchema.parse({ columnId: 'c1', op: 'like', value: 'x' })).toThrow();
  });

  it('rejects a clause with no column', () => {
    expect(() => WhereClauseSchema.parse({ columnId: '', op: 'eq', value: 1 })).toThrow();
  });
});

describe('OrderTermSchema', () => {
  it('accepts both directions', () => {
    expect(OrderTermSchema.parse({ columnId: 'c1', dir: 'asc' }).dir).toBe('asc');
    expect(OrderTermSchema.parse({ columnId: 'c1', dir: 'desc' }).dir).toBe('desc');
  });

  it('rejects a direction outside asc/desc', () => {
    expect(() => OrderTermSchema.parse({ columnId: 'c1', dir: 'up' })).toThrow();
  });
});

describe('DsViewConfigSchema', () => {
  it('accepts an empty config', () => {
    expect(DsViewConfigSchema.parse({})).toEqual({});
  });

  it('accepts a config with where, orderBy and groupByColumnId', () => {
    const config = {
      where: [{ columnId: 'c1', op: 'gt', value: 1 }],
      orderBy: [{ columnId: 'c1', dir: 'desc' }],
      groupByColumnId: 'c2',
    };
    expect(DsViewConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects a config whose where clause has an unknown operator', () => {
    expect(() => DsViewConfigSchema.parse({ where: [{ columnId: 'c1', op: 'like', value: 'x' }] })).toThrow();
  });
});

describe('ViewTypeSchema and RowActorKindSchema', () => {
  it('accept the grid/kanban views and the human/agent/trigger actors', () => {
    ['grid', 'kanban'].forEach((viewType) => expect(ViewTypeSchema.parse(viewType)).toBe(viewType));
    ['human', 'agent', 'trigger'].forEach((actorKind) => expect(RowActorKindSchema.parse(actorKind)).toBe(actorKind));
  });

  it('reject a view type or actor kind outside their sets', () => {
    expect(() => ViewTypeSchema.parse('calendar')).toThrow();
    expect(() => RowActorKindSchema.parse('robot')).toThrow();
  });
});

describe('data-store records', () => {
  it('a select column, a row, a view and both row-history shapes satisfy their types and survive a JSON round-trip', () => {
    const column: DsColumn = { id: 'c1', storeId: 's1', displayName: 'status', columnType: 'select', options: [{ id: 'todo', label: 'To do' }], sortOrder: 0 };
    const row: DsRow = { id: 'r1', storeId: 's1', data: { c1: 'todo' }, createdAt: 't0', updatedAt: 't0' };
    const view: DsView = { id: 'v1', storeId: 's1', displayName: 'Board', viewType: 'kanban', config: { groupByColumnId: 'c1' }, sortOrder: 0 };
    const created: DsRowHistoryEntry = { id: 'h1', rowId: 'r1', actorKind: 'human', actorLabel: 'You', change: { kind: 'create' }, createdAt: 't0' };
    const updated: DsRowHistoryEntry = { ...created, id: 'h2', actorKind: 'agent', change: { c1: { from: 'todo', to: 'done' } } };
    const deleted: DsRowHistoryEntry = { ...created, id: 'h3', actorKind: 'trigger', change: { kind: 'delete' } };
    const records = [column, row, view, created, updated, deleted];
    expect(JSON.parse(JSON.stringify(records))).toEqual(records);
  });

  it('refuses a row change kind other than create or delete', () => {
    // @ts-expect-error 'purge' is neither a known change kind nor a column diff
    const unknownKind: DsRowChange = { kind: 'purge' };
    expect(unknownKind).toEqual({ kind: 'purge' });
  });
});
