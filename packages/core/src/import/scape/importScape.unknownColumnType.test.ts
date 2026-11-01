import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { importScape } from './importScape.js';
import { renderImportReport } from './importReport.js';
import { BACKLOG_STORE_ID, buildScapeFixture, editScapeNotes, TITLE_COLUMN_ID } from './scapeFixture.testkit.js';

const UNKNOWN_TYPE_COLUMN_ID = 'synthetic-flag-column';

function importWithSyntheticFlagColumn() {
  const fixture = buildScapeFixture();
  editScapeNotes(fixture, (db) => {
    db.prepare("INSERT INTO data_store_column (id, storeID, displayName, columnType, sortOrder) VALUES (?, ?, 'Flag', 'bool', 9)").run(UNKNOWN_TYPE_COLUMN_ID, BACKLOG_STORE_ID);
  });
  const home = join(fixture.workDir, 'target');
  const report = importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'specs') });
  return { report, home };
}

it('imports the other columns and reports a column of an unknown type as not converted', () => {
  const { report, home } = importWithSyntheticFlagColumn();

  const db = new DatabaseSync(join(home, 'openfleet.db'));
  try {
    const importedColumnIds = new DataStoreRepository(db).listColumns(BACKLOG_STORE_ID).map((column) => column.id);
    expect(importedColumnIds).toContain(TITLE_COLUMN_ID);
    expect(importedColumnIds).not.toContain(UNKNOWN_TYPE_COLUMN_ID);
  } finally {
    db.close();
  }
  expect(report.unconvertedColumns).toEqual([{ columnId: UNKNOWN_TYPE_COLUMN_ID, columnType: 'bool', storeId: BACKLOG_STORE_ID }]);
});

it('lists the column of an unknown type in the rendered report', () => {
  const { report } = importWithSyntheticFlagColumn();

  const rendered = renderImportReport(report);

  expect(rendered).toContain(`${UNKNOWN_TYPE_COLUMN_ID} (bool) in table ${BACKLOG_STORE_ID}`);
});
