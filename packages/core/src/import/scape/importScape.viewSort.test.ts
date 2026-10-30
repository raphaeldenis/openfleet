import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { importScape } from './importScape.js';
import { BACKLOG_STORE_ID, buildScapeFixture, editScapeNotes, KANBAN_VIEW_ID, PRIORITY_COLUMN_ID, STATUS_COLUMN_ID } from './scapeFixture.testkit.js';

const GRID_VIEW_ID = 'V0000002-0000-0000-0000-000000000002';
const UNKNOWN_COLUMN_ID = 'C9999999-0000-0000-0000-000000000009';

function setup() {
  const fixture = buildScapeFixture();
  const home = join(fixture.workDir, 'target');
  const run = () => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'specs') });
  const storedConfigOf = (viewId: string) => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try { return new DataStoreRepository(db).listViews(BACKLOG_STORE_ID).find((view) => view.id === viewId)!.config; } finally { db.close(); }
  };
  const setKanbanConfig = (extra: Record<string, unknown>) => editScapeNotes(fixture, (db) => {
    db.prepare('UPDATE data_store_view SET config = ? WHERE id = ?').run(JSON.stringify({ groupByColumnID: STATUS_COLUMN_ID, ...extra }), KANBAN_VIEW_ID);
  });
  const addGridView = (config: Record<string, unknown>) => editScapeNotes(fixture, (db) => {
    db.prepare('INSERT INTO data_store_view (id, storeID, name, viewType, sortOrder, config, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(GRID_VIEW_ID, BACKLOG_STORE_ID, 'Grid', 'grid', 1, JSON.stringify(config), '2026-09-14 14:00:00.000', '2026-09-14 14:00:00.000');
  });
  return { fixture, home, run, storedConfigOf, setKanbanConfig, addGridView };
}

it('keeps the sort column and direction of a kanban view as orderBy', () => {
  const context = setup();
  context.setKanbanConfig({ sortColumnID: PRIORITY_COLUMN_ID, sortDescending: true });
  const report = context.run();
  expect(context.storedConfigOf(KANBAN_VIEW_ID).orderBy).toEqual([{ columnId: PRIORITY_COLUMN_ID, dir: 'desc' }]);
  expect(report.droppedViewFields).toEqual([]);
  expect(report.counts.views.notConverted).toBe(0);
});

it('keeps the sort of a grid view, ascending when sortDescending is false', () => {
  const context = setup();
  context.addGridView({ sortColumnID: PRIORITY_COLUMN_ID, sortDescending: false });
  const report = context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID)).toEqual({ orderBy: [{ columnId: PRIORITY_COLUMN_ID, dir: 'asc' }] });
  expect(report.droppedViewFields).toEqual([]);
});

it('sorts ascending when sortDescending is absent', () => {
  const context = setup();
  context.addGridView({ sortColumnID: PRIORITY_COLUMN_ID });
  context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID).orderBy).toEqual([{ columnId: PRIORITY_COLUMN_ID, dir: 'asc' }]);
});

it('creates no orderBy for a sort column that is not imported, and names the view', () => {
  const context = setup();
  context.addGridView({ sortColumnID: UNKNOWN_COLUMN_ID, sortDescending: true });
  const report = context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID)).toEqual({});
  expect(report.droppedViewFields).toEqual([{ viewId: GRID_VIEW_ID, fields: ['sortColumnID'] }]);
  expect(report.counts.views.notConverted).toBe(1);
});

it('lists a sortMode with its raw value as a loss and still keeps the sort column', () => {
  const context = setup();
  context.addGridView({ sortColumnID: PRIORITY_COLUMN_ID, sortDescending: true, sortMode: 'byColumn' });
  const report = context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID)).toEqual({ orderBy: [{ columnId: PRIORITY_COLUMN_ID, dir: 'desc' }] });
  expect(report.droppedViewFields).toEqual([{ viewId: GRID_VIEW_ID, fields: ['sortMode = byColumn'] }]);
});

it('neutralizes the raw sortMode value in the written report', () => {
  const context = setup();
  context.addGridView({ sortMode: '**x**\n## Injected' });
  context.run();
  const report = readFileSync(join(context.home, 'import-report.md'), 'utf8');
  expect(report).toContain('sortMode = \\*\\*x\\*\\* \\#\\# Injected');
  expect(report).not.toContain('\n## Injected');
});

it('reports a sortDescending that is not a boolean', () => {
  const context = setup();
  context.addGridView({ sortColumnID: PRIORITY_COLUMN_ID, sortDescending: 'yes' });
  const report = context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID).orderBy).toEqual([{ columnId: PRIORITY_COLUMN_ID, dir: 'asc' }]);
  expect(report.droppedViewFields).toEqual([{ viewId: GRID_VIEW_ID, fields: ['sortDescending'] }]);
});

it('applies the sort of an already imported view on re-import', () => {
  const context = setup();
  context.addGridView({});
  context.run();
  editScapeNotes(context.fixture, (db) => {
    db.prepare('UPDATE data_store_view SET config = ? WHERE id = ?').run(JSON.stringify({ sortColumnID: PRIORITY_COLUMN_ID, sortDescending: true }), GRID_VIEW_ID);
  });
  const second = context.run();
  expect(second.counts.views).toMatchObject({ updated: 1, conflict: 0 });
  expect(context.storedConfigOf(GRID_VIEW_ID).orderBy).toEqual([{ columnId: PRIORITY_COLUMN_ID, dir: 'desc' }]);
});

it('leaves a view edited in OpenFleet alone when the sort changes in Scape', () => {
  const context = setup();
  context.addGridView({ sortColumnID: PRIORITY_COLUMN_ID });
  context.run();
  const editedConfig = JSON.stringify({ orderBy: [{ columnId: STATUS_COLUMN_ID, dir: 'desc' }] });
  const db = new DatabaseSync(join(context.home, 'openfleet.db'));
  db.prepare('UPDATE ds_views SET config_json = ? WHERE id = ?').run(editedConfig, GRID_VIEW_ID);
  db.close();
  editScapeNotes(context.fixture, (scapeDb) => {
    scapeDb.prepare('UPDATE data_store_view SET config = ? WHERE id = ?').run(JSON.stringify({ sortColumnID: PRIORITY_COLUMN_ID, sortDescending: true }), GRID_VIEW_ID);
  });
  const second = context.run();
  expect(second.counts.views).toMatchObject({ conflict: 1, updated: 0 });
  expect(context.storedConfigOf(GRID_VIEW_ID)).toEqual({ orderBy: [{ columnId: STATUS_COLUMN_ID, dir: 'desc' }] });
});

it('lists a sortDescending that has no sort column to apply to', () => {
  const context = setup();
  context.addGridView({ sortDescending: true });
  const report = context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID)).toEqual({});
  expect(report.droppedViewFields).toEqual([{ viewId: GRID_VIEW_ID, fields: ['sortDescending'] }]);
});

it.each([[null], ['']])('reads a sortColumnID of %j as no sort column, without listing it', (emptyColumn) => {
  const context = setup();
  context.addGridView({ sortColumnID: emptyColumn });
  const report = context.run();
  expect(context.storedConfigOf(GRID_VIEW_ID)).toEqual({});
  expect(report.droppedViewFields).toEqual([]);
});

it.each([
  [{ nested: 'x' }, '(object)'],
  [['a'], '(array)'],
  [null, 'null'],
  [3, '3'],
  [true, 'true'],
])('lists a sortMode of %j as %s', (sortMode, expectedLabel) => {
  const context = setup();
  context.addGridView({ sortMode });
  const report = context.run();
  expect(report.droppedViewFields).toEqual([{ viewId: GRID_VIEW_ID, fields: [`sortMode = ${expectedLabel}`] }]);
});
