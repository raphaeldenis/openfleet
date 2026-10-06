import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { importScape } from './importScape.js';
import { BACKLOG_STORE_ID, buildScapeFixture, editScapeNotes, KANBAN_VIEW_ID, PRIORITY_COLUMN_ID, STATUS_COLUMN_ID, STATUS_DONE_OPTION_ID, TITLE_COLUMN_ID } from './scapeFixture.testkit.js';

function setup() {
  const fixture = buildScapeFixture();
  const home = join(fixture.workDir, 'target');
  const run = () => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'specs') });
  const withTarget = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try { return work(db); } finally { db.close(); }
  };
  const view = () => withTarget((db) => new DataStoreRepository(db).listViews(BACKLOG_STORE_ID)[0]!);
  return { fixture, run, withTarget, view };
}

it('preserves card settings through import, reopen and idempotent reimport', () => {
  const context = setup();
  const first = context.run();
  expect(context.view().config).toMatchObject({
    groupByColumnId: STATUS_COLUMN_ID, cardTitleColumnId: TITLE_COLUMN_ID,
    cardFields: [STATUS_COLUMN_ID, PRIORITY_COLUMN_ID], showUngrouped: true,
  });
  expect(first.droppedViewFields).toEqual([]);
  expect(context.run().counts.views).toMatchObject({ alreadyPresent: 1, updated: 0, conflict: 0 });
});

it('keeps valid references and reports each property with a partial or complete loss', () => {
  const context = setup();
  editScapeNotes(context.fixture, (db) => {
    db.prepare('UPDATE data_store_view SET config = ? WHERE id = ?').run(JSON.stringify({
      groupByColumnID: STATUS_COLUMN_ID, cardTitleColumnID: 'missing',
      cardFieldColumnIDs: [PRIORITY_COLUMN_ID, 'missing', PRIORITY_COLUMN_ID],
      columnOrder: [STATUS_DONE_OPTION_ID, 'missing'], showUngrouped: 'yes', futureSetting: true,
    }), KANBAN_VIEW_ID);
  });
  const report = context.run();
  expect(context.view().config).toEqual({ groupByColumnId: STATUS_COLUMN_ID, cardFields: [PRIORITY_COLUMN_ID], columnOrder: [STATUS_DONE_OPTION_ID] });
  expect(report.droppedViewFields).toEqual([{ viewId: KANBAN_VIEW_ID, fields: ['futureSetting', 'cardTitleColumnID', 'cardFieldColumnIDs', 'columnOrder', 'showUngrouped'] }]);
});

function restoreLegacyView(context: ReturnType<typeof setup>): void {
  context.withTarget((db) => {
    db.prepare('UPDATE ds_views SET config_json = ? WHERE id = ?').run(JSON.stringify({ groupByColumnId: STATUS_COLUMN_ID }), KANBAN_VIEW_ID);
    const legacyRecord = db.prepare('SELECT store_id, display_name, view_type, config_json, sort_order, created_at FROM ds_views WHERE id = ?').get(KANBAN_VIEW_ID)!;
    const sortedEntries = Object.entries(legacyRecord).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const legacyHash = createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex');
    db.prepare("UPDATE scape_import_ledger SET record_hash = ? WHERE kind = 'view' AND id = ?").run(legacyHash, KANBAN_VIEW_ID);
  });
}

it('enriches an intact legacy view using its original ledger hash', () => {
  const context = setup();
  context.run();
  restoreLegacyView(context);
  expect(context.run().counts.views).toMatchObject({ updated: 1, conflict: 0 });
  expect(context.view().config.cardTitleColumnId).toBe(TITLE_COLUMN_ID);
  expect(context.run().counts.views).toMatchObject({ updated: 0, alreadyPresent: 1 });
});

it('protects local changes and deletions when enriching legacy views', () => {
  const context = setup();
  context.run();
  restoreLegacyView(context);
  context.withTarget((db) => new DataStoreRepository(db).updateView(KANBAN_VIEW_ID, { groupByColumnId: STATUS_COLUMN_ID, cardFields: [] }));
  expect(context.run().counts.views.conflict).toBe(1);
  expect(context.view().config.cardFields).toEqual([]);
  context.withTarget((db) => new DataStoreRepository(db).deleteView(KANBAN_VIEW_ID));
  expect(context.run().counts.views.deletedInOpenFleet).toBe(1);
});
