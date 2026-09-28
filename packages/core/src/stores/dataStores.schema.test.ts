import { describe, expect, it } from 'vitest';
import { COLUMN_TYPES, ROW_ACTOR_KINDS, VIEW_TYPES } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';

type Db = ReturnType<typeof openDatabase>;

function openDatabaseWithProject(): Db {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p1', 'P', 't0')`).run();
  return db;
}

function insertProject(db: Db, id: string) {
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, 't0')`).run(id, `Project ${id}`);
}

function insertStore(db: Db, id: string, displayName = 'Store', projectId = 'p1') {
  db.prepare(`INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES (?, ?, ?, 't0', 't0')`).run(id, projectId, displayName);
}

function insertColumn(
  db: Db,
  id: string,
  storeId: string,
  overrides: { displayName?: string; columnType?: string; optionsJson?: string | null; sortOrder?: number | string } = {},
) {
  const { displayName = 'Column', columnType = 'text', optionsJson = null, sortOrder = 0 } = overrides;
  db.prepare(
    `INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 't0')`,
  ).run(id, storeId, displayName, columnType, optionsJson, sortOrder);
}

function insertRow(db: Db, id: string, storeId: string, dataJson: string | Buffer = '{}') {
  db.prepare(`INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, ?, 't0', 't0')`).run(id, storeId, dataJson);
}

function insertHistory(
  db: Db,
  id: string,
  storeId: string,
  overrides: { rowId?: string; actorKind?: string; actorLabel?: string; changeJson?: string } = {},
) {
  const { rowId = 'r1', actorKind = 'human', actorLabel = 'someone', changeJson = '{"kind":"create"}' } = overrides;
  db.prepare(`INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 't0')`).run(
    id,
    storeId,
    rowId,
    actorKind,
    actorLabel,
    changeJson,
  );
}

function insertView(
  db: Db,
  id: string,
  storeId: string,
  overrides: { displayName?: string; viewType?: string; configJson?: string; sortOrder?: number | string } = {},
) {
  const { displayName = 'View', viewType = 'grid', configJson = '{}', sortOrder = 0 } = overrides;
  db.prepare(`INSERT INTO ds_views (id, store_id, display_name, view_type, config_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 't0')`).run(
    id,
    storeId,
    displayName,
    viewType,
    configJson,
    sortOrder,
  );
}

function countRows(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function queryPlanOf(db: Db, sql: string, ...params: string[]): string {
  const steps = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return steps.map((step) => step.detail).join('\n');
}

const VALID_VALUES_BY_TABLE: Record<string, Record<string, string | number>> = {
  data_stores: { id: 's9', project_id: 'p1', display_name: 'Store', created_at: 't0', updated_at: 't0' },
  ds_columns: { id: 'c9', store_id: 's1', display_name: 'Column', column_type: 'text', sort_order: 0, created_at: 't0' },
  ds_rows: { id: 'r9', store_id: 's1', data_json: '{}', created_at: 't0', updated_at: 't0' },
  ds_row_history: { id: 'h9', store_id: 's1', row_id: 'r1', actor_kind: 'human', actor_label: 'someone', change_json: '{}', created_at: 't0' },
  ds_views: { id: 'v9', store_id: 's1', display_name: 'View', view_type: 'grid', config_json: '{}', sort_order: 0, created_at: 't0' },
};

const REQUIRED_COLUMNS = Object.entries(VALID_VALUES_BY_TABLE).flatMap(([table, values]) => Object.keys(values).map((column) => [table, column]));

function insertWithNullIn(db: Db, table: string, nullColumn: string) {
  const values = { ...VALID_VALUES_BY_TABLE[table], [nullColumn]: null };
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...Object.values(values));
}

describe('data store uniqueness', () => {
  it.each([
    { scope: 'stores in one project', insertNamed: (db: Db, id: string, name: string) => insertStore(db, id, name) },
    { scope: 'columns in one store', insertNamed: (db: Db, id: string, name: string) => insertColumn(db, id, 's1', { displayName: name }) },
    { scope: 'views in one store', insertNamed: (db: Db, id: string, name: string) => insertView(db, id, 's1', { displayName: name }) },
  ])('rejects two $scope whose names differ only by case', ({ insertNamed }) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1', 'Home');
    insertNamed(db, 'first', 'Bugs');

    expect(() => insertNamed(db, 'second', 'bugs')).toThrow(/UNIQUE/);
  });

  it.each([
    {
      scope: 'stores in two projects',
      insertNamedInEachScope: (db: Db) => {
        insertProject(db, 'p2');
        insertStore(db, 'first', 'Bugs', 'p1');
        insertStore(db, 'second', 'Bugs', 'p2');
      },
    },
    {
      scope: 'columns in two stores',
      insertNamedInEachScope: (db: Db) => {
        insertStore(db, 's2', 'Other');
        insertColumn(db, 'first', 's1', { displayName: 'Bugs' });
        insertColumn(db, 'second', 's2', { displayName: 'Bugs' });
      },
    },
    {
      scope: 'views in two stores',
      insertNamedInEachScope: (db: Db) => {
        insertStore(db, 's2', 'Other');
        insertView(db, 'first', 's1', { displayName: 'Bugs' });
        insertView(db, 'second', 's2', { displayName: 'Bugs' });
      },
    },
  ])('allows the same name for $scope', ({ insertNamedInEachScope }) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1', 'Home');

    expect(() => insertNamedInEachScope(db)).not.toThrow();
  });
});

describe('data store required columns', () => {
  it.each(REQUIRED_COLUMNS)('refuses NULL in %s.%s', (table, column) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertWithNullIn(db, table, column)).toThrow(/NOT NULL/);
  });
});

describe('data store non-empty identifiers', () => {
  it.each([
    { name: 'a store display name', insertEmpty: (db: Db) => insertStore(db, 's2', '') },
    { name: 'a column display name', insertEmpty: (db: Db) => insertColumn(db, 'c1', 's1', { displayName: '' }) },
    { name: 'a view display name', insertEmpty: (db: Db) => insertView(db, 'v1', 's1', { displayName: '' }) },
    { name: 'a row history actor label', insertEmpty: (db: Db) => insertHistory(db, 'h1', 's1', { actorLabel: '' }) },
    { name: 'a row history row id', insertEmpty: (db: Db) => insertHistory(db, 'h1', 's1', { rowId: '' }) },
  ])('refuses an empty string for $name', ({ insertEmpty }) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertEmpty(db)).toThrow(/CHECK/);
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
    insertHistory(db, 'h1', 's1');
    insertView(db, 'v1', 's1');

    db.prepare(`DELETE FROM data_stores WHERE id = 's1'`).run();

    const remainingByTable = ['ds_columns', 'ds_rows', 'ds_row_history', 'ds_views'].map((table) => countRows(db, table));
    expect(remainingByTable).toEqual([0, 0, 0, 0]);
  });

  it('keeps a row’s history after the row is deleted', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');
    insertRow(db, 'r1', 's1');
    insertHistory(db, 'h1', 's1');
    insertHistory(db, 'h2', 's1', { actorKind: 'agent', changeJson: '{"kind":"delete"}' });

    db.prepare(`DELETE FROM ds_rows WHERE id = 'r1'`).run();

    const survivingHistoryIds = (db.prepare(`SELECT id FROM ds_row_history WHERE row_id = 'r1' ORDER BY id`).all() as { id: string }[]).map((entry) => entry.id);
    expect(survivingHistoryIds).toEqual(['h1', 'h2']);
  });

  it('rejects a history entry for a store that does not exist', () => {
    const db = openDatabaseWithProject();

    expect(() => insertHistory(db, 'h1', 'missing')).toThrow(/FOREIGN KEY/);
  });

  it('rejects a row for a store that does not exist', () => {
    const db = openDatabaseWithProject();

    expect(() => insertRow(db, 'r1', 'missing')).toThrow(/FOREIGN KEY/);
  });
});

describe('data store reads use an index', () => {
  it.each([
    { read: 'rows by store', sql: `SELECT * FROM ds_rows WHERE store_id = ?` },
    { read: 'views by store', sql: `SELECT * FROM ds_views WHERE store_id = ?` },
    { read: 'history by store', sql: `SELECT * FROM ds_row_history WHERE store_id = ?` },
  ])('searches $read through an index', ({ sql }) => {
    const db = openDatabaseWithProject();

    expect(queryPlanOf(db, sql, 's1')).toMatch(/USING INDEX/);
  });

  it('reads a row’s history in order through the row index, without sorting', () => {
    const db = openDatabaseWithProject();

    const plan = queryPlanOf(db, `SELECT * FROM ds_row_history WHERE row_id = ? ORDER BY created_at, rowid`, 'r1');

    expect(plan).toMatch(/USING INDEX ds_row_history_row/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});

describe('data store JSON columns', () => {
  const JSON_OBJECT_COLUMNS = [
    { name: 'row data', insertJson: (db: Db, json: string) => insertRow(db, 'r1', 's1', json) },
    { name: 'row history change', insertJson: (db: Db, json: string) => insertHistory(db, 'h1', 's1', { changeJson: json }) },
    { name: 'view config', insertJson: (db: Db, json: string) => insertView(db, 'v1', 's1', { configJson: json }) },
  ];
  const insertOptions = (db: Db, json: string) => insertColumn(db, 'c1', 's1', { columnType: 'select', optionsJson: json });

  it.each([...JSON_OBJECT_COLUMNS, { name: 'column options', insertJson: insertOptions }])('rejects invalid JSON in $name', ({ insertJson }) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertJson(db, '{not json')).toThrow(/CHECK/);
  });

  it.each(JSON_OBJECT_COLUMNS.flatMap((column) => ['null', '5', '[]'].map((json) => ({ ...column, json }))))(
    'refuses $json where $name must be an object',
    ({ insertJson, json }) => {
      const db = openDatabaseWithProject();
      insertStore(db, 's1');

      expect(() => insertJson(db, json)).toThrow(/CHECK/);
    },
  );

  it.each(['null', '5', '{}'])('refuses %s where column options must be an array', (json) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertOptions(db, json)).toThrow(/CHECK/);
  });

  it('accepts an empty array as column options', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertOptions(db, '[]')).not.toThrow();
  });
});

describe('data store STRICT typing', () => {
  it.each([
    { name: 'a text column sort order', insertMistyped: (db: Db) => insertColumn(db, 'c1', 's1', { sortOrder: 'abc' }) },
    { name: 'a text view sort order', insertMistyped: (db: Db) => insertView(db, 'v1', 's1', { sortOrder: 'abc' }) },
    { name: 'a binary row data', insertMistyped: (db: Db) => insertRow(db, 'r1', 's1', Buffer.from('{}')) },
  ])('refuses $name', ({ insertMistyped }) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertMistyped(db)).toThrow(/cannot store/);
  });
});

describe('data store enums mirror the shared contracts', () => {
  it.each(COLUMN_TYPES)('accepts column type %s', (columnType) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', { columnType })).not.toThrow();
  });

  it('rejects an unknown column type', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', { columnType: 'not-a-column-type' })).toThrow(/CHECK/);
  });

  it.each(VIEW_TYPES)('accepts view type %s', (viewType) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertView(db, 'v1', 's1', { viewType })).not.toThrow();
  });

  it('rejects an unknown view type', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertView(db, 'v1', 's1', { viewType: 'not-a-view-type' })).toThrow(/CHECK/);
  });

  it.each(ROW_ACTOR_KINDS)('accepts row history actor kind %s', (actorKind) => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertHistory(db, 'h1', 's1', { actorKind })).not.toThrow();
  });

  it('rejects an unknown row history actor kind', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertHistory(db, 'h1', 's1', { actorKind: 'not-an-actor' })).toThrow(/CHECK/);
  });
});

describe('data store sort order', () => {
  it('rejects a negative column sort order', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertColumn(db, 'c1', 's1', { sortOrder: -1 })).toThrow(/CHECK/);
  });

  it('rejects a negative view sort order', () => {
    const db = openDatabaseWithProject();
    insertStore(db, 's1');

    expect(() => insertView(db, 'v1', 's1', { sortOrder: -1 })).toThrow(/CHECK/);
  });
});
