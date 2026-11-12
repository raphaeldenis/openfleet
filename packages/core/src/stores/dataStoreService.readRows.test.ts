import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { StoreNotFoundError } from './dataStoreRepository.js';
import { DataStoreRepository } from './dataStoreRepository.js';
import { DataStoreService, ReadBudgetExceededError } from './dataStoreService.js';

/*
 * Guards of the bounded read, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. early stop       `rows.length === limit` in readRows        -> 'reads one row of five thousand when the limit is one'
 *  2. projection       the json_patch projection of scanRows       -> 'does not read the columns it was not asked for'
 *  3. byte budget      `retainedBytes > maxBytes` in readRows       -> 'stops reading as soon as the retained rows outgrow the budget'
 *  4. owner check      `authorize` in readRows / naturalKeyColumnIdOf -> 'refuses a table of another project'
 *  5. sorted budget    the same budget on the sorted path           -> 'bounds the rows it holds to sort them'
 */
const scope = { projectId: 'p1' } as const;
const human = { kind: 'human', label: 'You' } as const;
const SIXTY_KIB = 60 * 1024;
const BUDGET_BYTES = 256 * 1024;

const openDatabases: DatabaseSync[] = [];
afterEach(() => openDatabases.splice(0).forEach((db) => db.close()));

function setup() {
  const db = openDatabase(':memory:');
  openDatabases.push(db);
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  const repo = new DataStoreRepository(db);
  let counter = 0;
  const service = new DataStoreService({ repo, db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const store = service.createStore({ ...scope, displayName: 'readings' });
  const nameColumn = service.addColumn(store.id, { ...scope, displayName: 'name', columnType: 'text' });
  const noteColumn = service.addColumn(store.id, { ...scope, displayName: 'note', columnType: 'text' });
  const fill = (items: Record<string, unknown>[]) => service.insertRows(store.id, { ...scope, actor: human, items });
  return { service, store, nameColumn, noteColumn, fill };
}

describe('readRows stops reading as soon as the answer is known', () => {
  it('reads one row of five thousand when the limit is one and no column is asked for', () => {
    const { service, store, nameColumn, fill } = setup();
    fill(Array.from({ length: 5000 }, (_, index) => ({ [nameColumn.id]: `row-${index}` })));

    const answer = service.readRows(store.id, { ...scope, limit: 1, columnIds: [], maxBytes: BUDGET_BYTES });

    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]?.data).toEqual({});
    expect(answer.scannedRowCount).toBe(1);
  });

  it('scans until the filter has found as many rows as the limit asks for', () => {
    const { service, store, nameColumn, fill } = setup();
    fill(Array.from({ length: 50 }, (_, index) => ({ [nameColumn.id]: index % 10 === 0 ? 'hit' : 'miss' })));

    const answer = service.readRows(store.id, { ...scope, where: [{ columnId: nameColumn.id, op: 'eq', value: 'hit' }], limit: 2, maxBytes: BUDGET_BYTES });

    expect(answer.rows).toHaveLength(2);
    expect(answer.scannedRowCount).toBe(11);
  });

  it('does not read the columns it was not asked for', () => {
    const { service, store, nameColumn, noteColumn, fill } = setup();
    fill(Array.from({ length: 50 }, (_, index) => ({ [nameColumn.id]: `row-${index}`, [noteColumn.id]: 'x'.repeat(SIXTY_KIB) })));

    const answer = service.readRows(store.id, { ...scope, limit: 50, columnIds: [nameColumn.id], maxBytes: BUDGET_BYTES });

    expect(answer.rows).toHaveLength(50);
    expect(answer.rows[0]?.data).toEqual({ [nameColumn.id]: 'row-0' });
  });

  it('answers the rows in the order asked for', () => {
    const { service, store, nameColumn, fill } = setup();
    fill([{ [nameColumn.id]: 'b' }, { [nameColumn.id]: 'c' }, { [nameColumn.id]: 'a' }]);

    const answer = service.readRows(store.id, { ...scope, orderBy: [{ columnId: nameColumn.id, dir: 'desc' }], limit: 2, columnIds: [nameColumn.id], maxBytes: BUDGET_BYTES });

    expect(answer.rows.map((row) => row.data[nameColumn.id])).toEqual(['c', 'b']);
  });
});

describe('readRows holds the rows it keeps to a budget of bytes', () => {
  it('stops reading as soon as the retained rows outgrow the budget', () => {
    const { service, store, noteColumn, fill } = setup();
    fill(Array.from({ length: 50 }, () => ({ [noteColumn.id]: 'x'.repeat(SIXTY_KIB) })));

    const read = () => service.readRows(store.id, { ...scope, limit: 50, maxBytes: BUDGET_BYTES });

    expect(read).toThrow(ReadBudgetExceededError);
    const scannedRowCount = (() => { try { read(); return -1; } catch (error) { return (error as ReadBudgetExceededError).scannedRowCount; } })();
    expect(scannedRowCount).toBeGreaterThan(0);
    expect(scannedRowCount).toBeLessThanOrEqual(Math.ceil(BUDGET_BYTES / SIXTY_KIB) + 1);
  });

  it('bounds the rows it holds to sort them', () => {
    const { service, store, nameColumn, noteColumn, fill } = setup();
    fill(Array.from({ length: 50 }, (_, index) => ({ [nameColumn.id]: String(index), [noteColumn.id]: 'x'.repeat(SIXTY_KIB) })));

    const read = () => service.readRows(store.id, { ...scope, orderBy: [{ columnId: nameColumn.id, dir: 'asc' }], limit: 1, maxBytes: BUDGET_BYTES });

    expect(read).toThrow(ReadBudgetExceededError);
  });

  it('refuses a column that does not exist', () => {
    const { service, store } = setup();

    expect(() => service.readRows(store.id, { ...scope, limit: 1, columnIds: ['no-such-column'], maxBytes: BUDGET_BYTES })).toThrow(/no-such-column/);
  });
});

describe('the owner of the table is checked by the new reads', () => {
  it('refuses a table of another project', () => {
    const { service, store } = setup();

    expect(() => service.readRows(store.id, { projectId: 'p2', limit: 1, maxBytes: BUDGET_BYTES })).toThrow(StoreNotFoundError);
    expect(() => service.naturalKeyColumnIdOf(store.id, { projectId: 'p2' })).toThrow(StoreNotFoundError);
  });

  it('answers the natural key of the table, or nothing when it has none', () => {
    const { service, store, nameColumn } = setup();
    const before = service.naturalKeyColumnIdOf(store.id, scope);

    service.setNaturalKey(store.id, { ...scope, columnId: nameColumn.id });

    expect(before).toBeUndefined();
    expect(service.naturalKeyColumnIdOf(store.id, scope)).toBe(nameColumn.id);
  });
});
