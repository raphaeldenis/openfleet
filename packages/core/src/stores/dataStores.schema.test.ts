import { describe, expect, it } from 'vitest';
import { COLUMN_TYPES, ROW_ACTOR_KINDS, VIEW_TYPES } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';

type Db = ReturnType<typeof openDatabase>;

function openDatabaseWithProject(): Db {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p1', 'P', 't0')`).run();
  return db;
}

function insertStore(db: Db, id: string, displayName = 'Store', projectId = 'p1') {
  db.prepare(`INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES (?, ?, ?, 't0', 't0')`).run(id, projectId, displayName);
}

function insertColumn(db: Db, id: string, storeId: string, displayName = 'Column', columnType = 'text', optionsJson: string | null = null, sortOrder = 0) {
  db.prepare(
    `INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 't0')`,
  ).run(id, storeId, displayName, columnType, optionsJson, sortOrder);
}

function insertRow(db: Db, id: string, storeId: string, dataJson = '{}') {
  db.prepare(`INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, ?, 't0', 't0')`).run(id, storeId, dataJson);
}

function insertHistory(db: Db, id: string, storeId: string, rowId: string, actorKind = 'human', changeJson = '{"kind":"create"}') {
  db.prepare(`INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES (?, ?, ?, ?, 'someone', ?, 't0')`).run(
    id,
    storeId,
    rowId,
    actorKind,
    changeJson,
  );
}

function insertView(db: Db, id: string, storeId: string, viewType = 'grid', configJson = '{}', sortOrder = 0) {
  db.prepare(`INSERT INTO ds_views (id, store_id, display_name, view_type, config_json, sort_order, created_at) VALUES (?, ?, 'View', ?, ?, ?, 't0')`).run(
    id,
    storeId,
    viewType,
    configJson,
    sortOrder,
  );
}

function countRows(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('data store uniqueness', () => {
  it('rejects two stores with the same name in one project', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1', 'Bugs');

    expect(() => insertStore(db, 's2', 'Bugs')).toThrow(/UNIQUE/);
  });

  it('allows the same store name in two different projects', () => {
    const db = openDatabaseWithProject();
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Q', 't0')`).run();
    insertStore(db, 's1', 'Bugs', 'p1');

    expect(() => insertStore(db, 's2', 'Bugs', 'p2')).not.toThrow();
  });

  it('rejects two columns with the same name in one store', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');
    insertColumn(db, 'c1', 's1', 'Status');

    expect(() => insertColumn(db, 'c2', 's1', 'Status')).toThrow(/UNIQUE/);
  });

  it('allows the same column name in two different stores', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1', 'A');
    insertStore(db, 's2', 'B');
    insertColumn(db, 'c1', 's1', 'Status');

    expect(() => insertColumn(db, 'c2', 's2', 'Status')).not.toThrow();
  });
});

describe('data store foreign keys', () => {
  it('rejects a store whose project does not exist', () => {
    const db = openDatabaseWithProject();

    expect(() => insertStore(db, 's1', 'Store', 'missing')).toThrow(/FOREIGN KEY/);
  });

  it('deletes a store’s columns, rows, row history and views together with the store', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');
    insertColumn(db, 'c1', 's1');
    insertRow(db, 'r1', 's1');
    insertHistory(db, 'h1', 's1', 'r1');
    insertView(db, 'v1', 's1');

    db.prepare(`DELETE FROM data_stores WHERE id = 's1'`).run();

    const remainingByTable = ['ds_columns', 'ds_rows', 'ds_row_history', 'ds_views'].map((table) => countRows(db, table));
    expect(remainingByTable).toEqual([0, 0, 0, 0]);
  });

  it('keeps another store’s children when one store is deleted', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1', 'A');
    insertStore(db, 's2', 'B');
    insertRow(db, 'r1', 's1');
    insertRow(db, 'r2', 's2');
    insertHistory(db, 'h2', 's2', 'r2');

    db.prepare(`DELETE FROM data_stores WHERE id = 's1'`).run();

    expect(countRows(db, 'ds_rows')).toBe(1);
    expect(countRows(db, 'ds_row_history')).toBe(1);
  });

  it('keeps a row’s history after the row is deleted', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');
    insertRow(db, 'r1', 's1');
    insertHistory(db, 'h1', 's1', 'r1');
    insertHistory(db, 'h2', 's1', 'r1', 'agent', '{"kind":"delete"}');

    db.prepare(`DELETE FROM ds_rows WHERE id = 'r1'`).run();

    const survivingHistoryIds = (db.prepare(`SELECT id FROM ds_row_history WHERE row_id = 'r1' ORDER BY id`).all() as { id: string }[]).map((entry) => entry.id);
    expect(survivingHistoryIds).toEqual(['h1', 'h2']);
  });

  it('rejects a history entry for a store that does not exist', () => {
    const db = openDatabaseWithProject();

    expect(() => insertHistory(db, 'h1', 'missing', 'r1')).toThrow(/FOREIGN KEY/);
  });

  it('indexes history by row and by store', () => {
    const db = openDatabaseWithProject();

    const historyIndexes = (db.prepare(`PRAGMA index_list('ds_row_history')`).all() as { name: string }[]).map((index) => index.name);

    expect(historyIndexes).toEqual(expect.arrayContaining(['ds_row_history_row', 'ds_row_history_store']));
  });

  it('rejects a row for a store that does not exist', () => {
    const db = openDatabaseWithProject();

    expect(() => insertRow(db, 'r1', 'missing')).toThrow(/FOREIGN KEY/);
  });

  it('indexes views by store', () => {
    const db = openDatabaseWithProject();

    const viewIndexes = (db.prepare(`PRAGMA index_list('ds_views')`).all() as { name: string }[]).map((index) => index.name);

    expect(viewIndexes).toContain('ds_views_store');
  });
});

describe('data store JSON columns', () => {
  it.each([
    { name: 'row data', insertInvalid: (db: Db) => insertRow(db, 'r1', 's1', '{not json') },
    { name: 'row history change', insertInvalid: (db: Db) => insertHistory(db, 'h1', 's1', 'r1', 'human', '{not json') },
    { name: 'view config', insertInvalid: (db: Db) => insertView(db, 'v1', 's1', 'grid', '{not json') },
    { name: 'column options', insertInvalid: (db: Db) => insertColumn(db, 'c1', 's1', 'Status', 'select', '[not json') },
  ])('rejects invalid JSON in $name', ({ insertInvalid }) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertInvalid(db)).toThrow(/CHECK/);
  });

  it('accepts a column without options', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', 'Title', 'text', null)).not.toThrow();
  });
});

describe('data store enums mirror the shared contracts', () => {
  it.each(COLUMN_TYPES)('accepts column type %s', (columnType) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', 'Column', columnType)).not.toThrow();
  });

  it('rejects an unknown column type', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', 'Column', 'not-a-column-type')).toThrow(/CHECK/);
  });

  it.each(VIEW_TYPES)('accepts view type %s', (viewType) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertView(db, 'v1', 's1', viewType)).not.toThrow();
  });

  it('rejects an unknown view type', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertView(db, 'v1', 's1', 'not-a-view-type')).toThrow(/CHECK/);
  });

  it.each(ROW_ACTOR_KINDS)('accepts row history actor kind %s', (actorKind) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertHistory(db, 'h1', 's1', 'r1', actorKind)).not.toThrow();
  });

  it('rejects an unknown row history actor kind', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertHistory(db, 'h1', 's1', 'r1', 'not-an-actor')).toThrow(/CHECK/);
  });
});

describe('data store sort order', () => {
  it('rejects a negative column sort order', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', 'Column', 'text', null, -1)).toThrow(/CHECK/);
  });

  it('rejects a negative view sort order', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertView(db, 'v1', 's1', 'grid', '{}', -1)).toThrow(/CHECK/);
  });
});
