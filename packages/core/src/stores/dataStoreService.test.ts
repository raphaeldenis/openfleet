import { describe, expect, it } from 'vitest';
import type { DsColumn, RowActorKind } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository, DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError } from './dataStoreRepository.js';
import {
  ConstraintError, DataStoreService, DuplicateIdError, InvalidActorError, InvalidCellValueError, InvalidColumnDefinitionError,
  InvalidNameError, StoreHasRowsError, ViewNotFoundError,
} from './dataStoreService.js';

const scope = { projectId: 'p1' } as const;
const other = { projectId: 'p2' } as const;
const human = { kind: 'human', label: 'You' } as const;

function setup(options: { newId?: () => string } = {}) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  const repo = new DataStoreRepository(db);
  let counter = 0;
  const service = new DataStoreService({ repo, db, clock: () => '2026-01-01T00:00:00.000Z', newId: options.newId ?? (() => `id-${++counter}`) });
  const historyCount = () => (db.prepare('SELECT COUNT(*) AS n FROM ds_row_history').get() as { n: number }).n;
  const rowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM ds_rows').get() as { n: number }).n;
  return { db, repo, service, historyCount, rowCount };
}

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

const todoOptions = [{ id: 'todo', label: 'todo' }, { id: 'doing', label: 'in progress' }, { id: 'done', label: 'done' }];

function backlog() {
  const ctx = setup();
  const store = ctx.service.createStore({ ...scope, displayName: 'backlog' });
  const col = (displayName: string, columnType: DsColumn['columnType'], options?: { id: string; label: string }[]) =>
    ctx.service.addColumn(store.id, { ...scope, displayName, columnType, ...(options ? { options } : {}) }).id;
  const cols = {
    title: col('title', 'text'),
    priority: col('priority', 'number'),
    due: col('due', 'date'),
    status: col('status', 'select', todoOptions),
    meta: col('meta', 'json'),
  };
  return { ...ctx, store, cols };
}

describe('DataStoreService', () => {
  describe('query', () => {
    it('filters, sorts and limits: priorities 3,1,2 with gt 1 asc limit 1 gives [2]', () => {
      const { service, store, cols } = backlog();
      for (const priority of [3, 1, 2]) service.insertRow(store.id, { ...scope, data: { [cols.priority]: priority }, actor: human });

      const rows = service.query(store.id, {
        ...scope, where: [{ columnId: cols.priority, op: 'gt', value: 1 }], orderBy: [{ columnId: cols.priority, dir: 'asc' }], limit: 1,
      });

      expect(rows.map((row) => row.data[cols.priority])).toEqual([2]);
    });

    it('supports eq, neq, gte, lt, lte and contains', () => {
      const { service, store, cols } = backlog();
      for (const [title, priority] of [['Fix bug', 1], ['Write docs', 2], ['fix typo', 3]] as const) {
        service.insertRow(store.id, { ...scope, data: { [cols.title]: title, [cols.priority]: priority }, actor: human });
      }
      const priorities = (op: 'eq' | 'neq' | 'gte' | 'lt' | 'lte', value: number) =>
        service.query(store.id, { ...scope, where: [{ columnId: cols.priority, op, value }], orderBy: [{ columnId: cols.priority, dir: 'asc' }] }).map((r) => r.data[cols.priority]);

      expect(priorities('eq', 2)).toEqual([2]);
      expect(priorities('neq', 2)).toEqual([1, 3]);
      expect(priorities('gte', 2)).toEqual([2, 3]);
      expect(priorities('lt', 2)).toEqual([1]);
      expect(priorities('lte', 2)).toEqual([1, 2]);
      expect(service.query(store.id, { ...scope, where: [{ columnId: cols.title, op: 'contains', value: 'fix' }] })).toHaveLength(2);
    });

    it('never throws on a type mismatch: the row just does not match', () => {
      const { service, store, cols } = backlog();
      service.insertRow(store.id, { ...scope, data: { [cols.priority]: 5, [cols.meta]: { a: 1 } }, actor: human });
      service.insertRow(store.id, { ...scope, data: { [cols.meta]: 'text' }, actor: human });

      expect(service.query(store.id, { ...scope, where: [{ columnId: cols.priority, op: 'gt', value: 'abc' }] })).toEqual([]);
      expect(service.query(store.id, { ...scope, where: [{ columnId: cols.meta, op: 'gt', value: 1 }] })).toEqual([]);
      expect(service.query(store.id, { ...scope, where: [{ columnId: cols.priority, op: 'contains', value: 5 }] })).toEqual([]);
      expect(service.query(store.id, { ...scope, where: [{ columnId: cols.priority, op: 'eq', value: '5' }] })).toEqual([]);
    });

    it('sorts nulls last in both directions and keeps ties in insertion order', () => {
      const { service, store, cols } = backlog();
      const data = [{ t: 'a' }, { t: 'b', p: 2 }, { t: 'c', p: 1 }, { t: 'd', p: 2 }];
      for (const { t, p } of data as { t: string; p?: number }[]) {
        service.insertRow(store.id, { ...scope, data: { [cols.title]: t, ...(p === undefined ? {} : { [cols.priority]: p }) }, actor: human });
      }
      const titles = (dir: 'asc' | 'desc') => service.query(store.id, { ...scope, orderBy: [{ columnId: cols.priority, dir }] }).map((r) => r.data[cols.title]);

      expect(titles('asc')).toEqual(['c', 'b', 'd', 'a']);
      expect(titles('desc')).toEqual(['b', 'd', 'c', 'a']);
    });

    it('refuses an unknown column and a bad limit', () => {
      const { service, store } = backlog();

      expect(thrownBy(() => service.query(store.id, { ...scope, where: [{ columnId: 'nope', op: 'eq', value: 1 }] }))).toBeInstanceOf(UnknownColumnError);
      expect(thrownBy(() => service.query(store.id, { ...scope, orderBy: [{ columnId: 'nope', dir: 'asc' }] }))).toBeInstanceOf(UnknownColumnError);
      expect(() => service.query(store.id, { ...scope, limit: -1 })).toThrow();
    });
  });

  describe('views and kanban', () => {
    it('buckets rows by select option in option order, empty buckets included', () => {
      const { service, store, cols } = backlog();
      service.insertRow(store.id, { ...scope, data: { [cols.title]: 'a', [cols.status]: 'done' }, actor: human });
      service.insertRow(store.id, { ...scope, data: { [cols.title]: 'b', [cols.status]: 'todo' }, actor: human });
      const view = service.createView(store.id, { ...scope, displayName: 'board', viewType: 'kanban', config: { groupByColumnId: cols.status } });

      const groups = service.kanbanGroups(view.id, scope);

      expect(groups.map((g) => g.option.label)).toEqual(['todo', 'in progress', 'done']);
      expect(groups.map((g) => g.rows.map((r) => r.data[cols.title]))).toEqual([['b'], [], ['a']]);
    });

    it('throws when the group-by column is not a select column', () => {
      const { service, store, cols } = backlog();
      const view = service.createView(store.id, { ...scope, displayName: 'board', viewType: 'kanban', config: { groupByColumnId: cols.title } });

      expect(() => service.kanbanGroups(view.id, scope)).toThrow(/must be a select column/);
    });

    it('lists views in creation order and rejects a config naming an unknown column', () => {
      const { service, store } = backlog();
      service.createView(store.id, { ...scope, displayName: 'one', viewType: 'grid' });
      service.createView(store.id, { ...scope, displayName: 'two', viewType: 'grid' });

      expect(service.listViews(store.id, scope).map((v) => v.displayName)).toEqual(['one', 'two']);
      expect(thrownBy(() => service.createView(store.id, { ...scope, displayName: 'x', viewType: 'grid', config: { orderBy: [{ columnId: 'nope', dir: 'asc' }] } }))).toBeInstanceOf(UnknownColumnError);
    });
  });

  describe('cross-project refusal', () => {
    it('refuses every method for another project and changes nothing', () => {
      const { service, store, cols, rowCount, repo } = backlog();
      const row = service.insertRow(store.id, { ...scope, data: { [cols.title]: 'x' }, actor: human });
      const view = service.createView(store.id, { ...scope, displayName: 'v', viewType: 'grid' });

      const calls: [string, () => unknown][] = [
        ['addColumn', () => service.addColumn(store.id, { ...other, displayName: 'z', columnType: 'text' })],
        ['insertRow', () => service.insertRow(store.id, { ...other, data: {}, actor: human })],
        ['updateRow', () => service.updateRow(store.id, row.id, { ...other, patch: { [cols.title]: 'y' }, actor: human })],
        ['deleteRow', () => service.deleteRow(store.id, row.id, { ...other, actor: human })],
        ['insertRows', () => service.insertRows(store.id, { ...other, items: [{}], actor: human })],
        ['updateRows', () => service.updateRows(store.id, { ...other, items: [{ rowId: row.id, patch: { [cols.title]: 'y' } }], actor: human })],
        ['query', () => service.query(store.id, other)],
        ['createView', () => service.createView(store.id, { ...other, displayName: 'w', viewType: 'grid' })],
        ['listViews', () => service.listViews(store.id, other)],
        ['deleteStore', () => service.deleteStore(store.id, { ...other, force: true })],
        ['missing store', () => service.query('nope', scope)],
      ];
      for (const [name, call] of calls) expect(thrownBy(call), name).toBeInstanceOf(StoreNotFoundError);
      expect(thrownBy(() => service.kanbanGroups(view.id, other))).toBeInstanceOf(ViewNotFoundError);
      expect(thrownBy(() => service.kanbanGroups('nope', scope))).toBeInstanceOf(ViewNotFoundError);

      expect(rowCount()).toBe(1);
      expect(repo.listRows(store.id)[0]?.data[cols.title]).toBe('x');
      expect(repo.listColumns(store.id)).toHaveLength(5);
      expect(repo.findStore(store.id)).toBeDefined();
    });
  });

  describe('cell validation', () => {
    const accepted: [string, (c: Record<string, string>) => Record<string, unknown>][] = [
      ['select', (c) => ({ [c.status!]: 'doing' })],
      ['number', (c) => ({ [c.priority!]: 3.5 })],
      ['date', (c) => ({ [c.due!]: '2026-02-28' })],
      ['date-time', (c) => ({ [c.due!]: '2026-02-28T10:00:00.000Z' })],
      ['text', (c) => ({ [c.title!]: 'hello' })],
      ['json', (c) => ({ [c.meta!]: { any: ['thing', 1] } })],
      ['null clears', (c) => ({ [c.title!]: null, [c.status!]: null, [c.priority!]: null, [c.due!]: null })],
    ];
    const refused: [string, string, unknown][] = [
      ['select: unknown option', 'status', 'nope'],
      ['select: label instead of id', 'status', 'in progress'],
      ['select: number', 'status', 1],
      ['number: string', 'priority', '3'],
      ['number: NaN', 'priority', Number.NaN],
      ['number: Infinity', 'priority', Number.POSITIVE_INFINITY],
      ['date: free text', 'due', 'tomorrow'],
      ['date: impossible day', 'due', '2026-02-31'],
      ['date: number', 'due', 1_700_000_000],
      ['text: number', 'title', 5],
      ['text: object', 'title', {}],
      ['json: function', 'meta', () => 1],
    ];

    it.each(accepted)('accepts a valid %s value on insert and update', (_name, build) => {
      const { service, store, cols } = backlog();
      const data = build(cols);

      const inserted = service.insertRow(store.id, { ...scope, data, actor: human });
      const updated = service.updateRow(store.id, inserted.id, { ...scope, patch: data, actor: human });

      expect(inserted.data).toEqual(JSON.parse(JSON.stringify(data)));
      expect(updated.id).toBe(inserted.id);
    });

    it('clears an existing cell with null', () => {
      const { service, store, cols } = backlog();
      const row = service.insertRow(store.id, { ...scope, data: { [cols.status]: 'todo' }, actor: human });

      const cleared = service.updateRow(store.id, row.id, { ...scope, patch: { [cols.status]: null }, actor: human });

      expect(cleared.data[cols.status]).toBeNull();
    });

    it.each(refused)('refuses %s on insert and on update, writing nothing', (_name, column, value) => {
      const { service, store, cols, historyCount, rowCount } = backlog();
      const columnId = cols[column as keyof typeof cols];
      const row = service.insertRow(store.id, { ...scope, data: {}, actor: human });
      const historyBefore = historyCount();

      const onInsert = thrownBy(() => service.insertRow(store.id, { ...scope, data: { [columnId]: value }, actor: human }));
      const onUpdate = thrownBy(() => service.updateRow(store.id, row.id, { ...scope, patch: { [columnId]: value }, actor: human }));

      expect(onInsert).toBeInstanceOf(InvalidCellValueError);
      expect((onInsert as InvalidCellValueError).columnId).toBe(columnId);
      expect(onUpdate).toBeInstanceOf(InvalidCellValueError);
      expect(rowCount()).toBe(1);
      expect(historyCount()).toBe(historyBefore);
    });

    it('refuses an unknown column id', () => {
      const { service, store } = backlog();

      expect(thrownBy(() => service.insertRow(store.id, { ...scope, data: { nope: 1 }, actor: human }))).toBeInstanceOf(UnknownColumnError);
    });
  });

  describe('names', () => {
    it("trims and NFC-normalizes: '  Bugs' and 'Bugs' collide, and so do NFD and NFC", () => {
      const { service, store } = backlog();
      const created = service.createStore({ ...scope, displayName: '  Bugs ' });

      expect(created.displayName).toBe('Bugs');
      expect(thrownBy(() => service.createStore({ ...scope, displayName: 'Bugs' }))).toBeInstanceOf(DuplicateNameError);
      service.createStore({ ...scope, displayName: 'Café' });
      expect(thrownBy(() => service.createStore({ ...scope, displayName: 'Café' }))).toBeInstanceOf(DuplicateNameError);

      service.addColumn(store.id, { ...scope, displayName: '  Bugs', columnType: 'text' });
      expect(thrownBy(() => service.addColumn(store.id, { ...scope, displayName: 'Bugs', columnType: 'text' }))).toBeInstanceOf(DuplicateNameError);
      const column = service.addColumn(store.id, { ...scope, displayName: 'Café', columnType: 'text' });
      expect(column.displayName).toBe('Café');
      expect(thrownBy(() => service.addColumn(store.id, { ...scope, displayName: 'Café', columnType: 'text' }))).toBeInstanceOf(DuplicateNameError);

      service.createView(store.id, { ...scope, displayName: ' Board', viewType: 'grid' });
      expect(thrownBy(() => service.createView(store.id, { ...scope, displayName: 'Board ', viewType: 'grid' }))).toBeInstanceOf(DuplicateNameError);
    });

    it('rejects a name that is empty after trimming', () => {
      const { service, store } = backlog();

      expect(thrownBy(() => service.createStore({ ...scope, displayName: '  \t ' }))).toBeInstanceOf(InvalidNameError);
      expect(thrownBy(() => service.addColumn(store.id, { ...scope, displayName: '', columnType: 'text' }))).toBeInstanceOf(InvalidNameError);
      expect(thrownBy(() => service.createView(store.id, { ...scope, displayName: ' ', viewType: 'grid' }))).toBeInstanceOf(InvalidNameError);
    });
  });

  describe('column definitions', () => {
    it('needs at least one option with unique ids on a select column, and none on other types', () => {
      const { service, store } = backlog();
      const add = (columnType: DsColumn['columnType'], options?: { id: string; label: string }[]) =>
        thrownBy(() => service.addColumn(store.id, { ...scope, displayName: `c-${Math.random()}`, columnType, ...(options ? { options } : {}) }));

      expect(add('select')).toBeInstanceOf(InvalidColumnDefinitionError);
      expect(add('select', [])).toBeInstanceOf(InvalidColumnDefinitionError);
      expect(add('select', [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }])).toBeInstanceOf(InvalidColumnDefinitionError);
      expect(add('select', [{ id: '', label: 'A' }])).toBeInstanceOf(InvalidColumnDefinitionError);
      expect(add('text', [{ id: 'a', label: 'A' }])).toBeInstanceOf(InvalidColumnDefinitionError);
      expect(add('number', [])).toBeInstanceOf(InvalidColumnDefinitionError);
      expect(add('select', [{ id: 'a', label: 'A' }])).not.toBeInstanceOf(Error);
    });
  });

  describe('deleteStore', () => {
    it('refuses a store with rows unless forced, and force erases its history', () => {
      const { service, store, cols, repo, db, rowCount } = backlog();
      service.insertRow(store.id, { ...scope, data: { [cols.title]: 'x' }, actor: human });

      const refusal = thrownBy(() => service.deleteStore(store.id, scope));
      expect(refusal).toBeInstanceOf(StoreHasRowsError);
      expect(repo.findStore(store.id)).toBeDefined();
      expect(rowCount()).toBe(1);

      service.deleteStore(store.id, { ...scope, force: true });
      expect(repo.findStore(store.id)).toBeUndefined();
      expect(rowCount()).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM ds_row_history').get() as { n: number }).n).toBe(0);
    });

    it('deletes an empty store without force', () => {
      const { service, store, repo } = backlog();

      service.deleteStore(store.id, scope);

      expect(repo.findStore(store.id)).toBeUndefined();
    });
  });

  describe('deleteRow', () => {
    it('deletes a row and reports a missing one', () => {
      const { service, store, rowCount } = backlog();
      const row = service.insertRow(store.id, { ...scope, data: {}, actor: human });

      service.deleteRow(store.id, row.id, { ...scope, actor: human });

      expect(rowCount()).toBe(0);
      expect(thrownBy(() => service.deleteRow(store.id, row.id, { ...scope, actor: human }))).toBeInstanceOf(RowNotFoundError);
    });
  });

  describe('batches', () => {
    it('inserts all rows in one call', () => {
      const { service, store, cols, rowCount } = backlog();

      const rows = service.insertRows(store.id, { ...scope, actor: human, items: [{ [cols.priority]: 1 }, { [cols.priority]: 2 }] });

      expect(rows).toHaveLength(2);
      expect(rowCount()).toBe(2);
    });

    it('insertRows is all-or-nothing, also when the caller already holds a transaction', () => {
      const { service, store, cols, rowCount, historyCount, db } = backlog();
      const items = [{ [cols.priority]: 1 }, { [cols.priority]: 'bad' }];

      expect(thrownBy(() => service.insertRows(store.id, { ...scope, actor: human, items }))).toBeInstanceOf(InvalidCellValueError);
      expect([rowCount(), historyCount()]).toEqual([0, 0]);

      db.exec('BEGIN');
      expect(thrownBy(() => service.insertRows(store.id, { ...scope, actor: human, items }))).toBeInstanceOf(InvalidCellValueError);
      expect(db.isTransaction).toBe(true);
      service.insertRows(store.id, { ...scope, actor: human, items: [{ [cols.priority]: 1 }] });
      db.exec('ROLLBACK');
      expect([rowCount(), historyCount()]).toEqual([0, 0]);
    });

    it('rolls back earlier inserts when a later write fails in the database', () => {
      let calls = 0;
      const ctx = setup({ newId: () => (calls++ < 3 ? `id-${calls}` : 'id-3') });
      const store = ctx.service.createStore({ ...scope, displayName: 's' }); // id-1
      ctx.service.addColumn(store.id, { ...scope, displayName: 'c', columnType: 'text' }); // id-2

      const error = thrownBy(() => ctx.service.insertRows(store.id, { ...scope, actor: human, items: [{}, {}] })); // id-3, id-3

      expect(error).toBeInstanceOf(DuplicateIdError);
      expect([ctx.rowCount(), ctx.historyCount()]).toEqual([0, 0]);
    });

    it('updateRows applies every patch or none', () => {
      const { service, store, cols, repo } = backlog();
      const [a, b] = service.insertRows(store.id, { ...scope, actor: human, items: [{ [cols.priority]: 1 }, { [cols.priority]: 2 }] }) as unknown as [{ id: string }, { id: string }];

      service.updateRows(store.id, { ...scope, actor: human, items: [{ rowId: a.id, patch: { [cols.priority]: 10 } }, { rowId: b.id, patch: { [cols.priority]: 20 } }] });
      expect(repo.listRows(store.id).map((r) => r.data[cols.priority])).toEqual([10, 20]);

      const missing = thrownBy(() => service.updateRows(store.id, { ...scope, actor: human, items: [{ rowId: a.id, patch: { [cols.priority]: 99 } }, { rowId: 'ghost', patch: { [cols.priority]: 1 } }] }));
      expect(missing).toBeInstanceOf(RowNotFoundError);
      const invalid = thrownBy(() => service.updateRows(store.id, { ...scope, actor: human, items: [{ rowId: a.id, patch: { [cols.priority]: 99 } }, { rowId: b.id, patch: { [cols.priority]: 'x' } }] }));
      expect(invalid).toBeInstanceOf(InvalidCellValueError);
      expect(repo.listRows(store.id).map((r) => r.data[cols.priority])).toEqual([10, 20]);
    });
  });

  describe('error mapping', () => {
    it('maps a duplicate id to DuplicateIdError without leaking SQL', () => {
      const ctx = setup({ newId: () => 'same' });
      const store = ctx.service.createStore({ ...scope, displayName: 's' });
      expect(store.id).toBe('same');

      ctx.service.addColumn(store.id, { ...scope, displayName: 'c1', columnType: 'text' });
      const error = thrownBy(() => ctx.service.addColumn(store.id, { ...scope, displayName: 'c2', columnType: 'text' }));

      expect(error).toBeInstanceOf(DuplicateIdError);
      expect((error as Error).message).not.toMatch(/sqlite|constraint|ds_columns|UNIQUE/i);
    });

    it('maps a bad actor kind to InvalidActorError without leaking SQL', () => {
      const { service, store } = backlog();

      const error = thrownBy(() => service.insertRow(store.id, { ...scope, data: {}, actor: { kind: 'robot' as RowActorKind, label: 'x' } }));

      expect(error).toBeInstanceOf(InvalidActorError);
      expect((error as Error).message).not.toMatch(/sqlite|constraint|actor_kind|CHECK/i);
    });

    it('maps an unknown project to a typed error', () => {
      const { service } = setup();

      const error = thrownBy(() => service.createStore({ projectId: 'ghost', displayName: 's' }));

      expect(error).toBeInstanceOf(ConstraintError);
      expect((error as Error).message).not.toMatch(/sqlite|FOREIGN/i);
    });
  });
});
