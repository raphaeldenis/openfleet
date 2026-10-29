import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { DataStoreService } from '../../stores/dataStoreService.js';
import { importScape } from './importScape.js';
import { BACKLOG_STORE_ID, buildScapeFixture, editScapeNotes, DUE_COLUMN_ID, PRIORITY_COLUMN_ID, TITLE_COLUMN_ID } from './scapeFixture.testkit.js';

const METADATA_COLUMNS = ['required INTEGER', 'displayColumnID TEXT', 'config TEXT', 'displayWidth INTEGER', 'wrapMode TEXT', 'wrapMaxLines INTEGER'];

function fixtureWithMetadataColumns() {
  const fixture = buildScapeFixture();
  editScapeNotes(fixture, (db) => { for (const column of METADATA_COLUMNS) db.exec(`ALTER TABLE data_store_column ADD COLUMN ${column}`); });
  return fixture;
}

describe('re-importing a Scape display column that would close a cycle with what OpenFleet stores', () => {
  it('keeps the stored display column, reports the Scape value, and leaves a store where a third column can still be edited', () => {
    const fixture = fixtureWithMetadataColumns();
    const options = { scapeDir: fixture.scapeDir, home: join(fixture.workDir, 'target'), superpowersRoot: join(fixture.workDir, 'specs') };
    const databasePath = join(options.home, 'openfleet.db');
    importScape(options);
    const editedInOpenFleet = new DatabaseSync(databasePath);
    const projectId = (editedInOpenFleet.prepare('SELECT project_id AS id FROM data_stores WHERE id = ?').get(BACKLOG_STORE_ID) as { id: string }).id;
    new DataStoreService({ repo: new DataStoreRepository(editedInOpenFleet), db: editedInOpenFleet, clock: () => '2026-01-01T00:00:00.000Z', newId: () => 'unused' })
      .updateColumn(BACKLOG_STORE_ID, { projectId, columnId: TITLE_COLUMN_ID, changes: { displayColumnId: PRIORITY_COLUMN_ID } });
    editedInOpenFleet.close();
    editScapeNotes(fixture, (db) => db.prepare('UPDATE data_store_column SET displayColumnID = ? WHERE id = ?').run(TITLE_COLUMN_ID, PRIORITY_COLUMN_ID));

    const report = importScape(options);

    const reimported = new DatabaseSync(databasePath);
    const displayColumnOf = (columnId: string) => (reimported.prepare('SELECT display_column_id AS id FROM ds_columns WHERE id = ?').get(columnId) as { id: string | null }).id;
    expect(displayColumnOf(TITLE_COLUMN_ID)).toBe(PRIORITY_COLUMN_ID);
    expect(displayColumnOf(PRIORITY_COLUMN_ID)).toBeNull();
    expect(report.droppedColumnMetadata).toEqual([{ columnId: PRIORITY_COLUMN_ID, field: 'displayColumnID', value: TITLE_COLUMN_ID }]);
    const service = new DataStoreService({ repo: new DataStoreRepository(reimported), db: reimported, clock: () => '2026-01-01T00:00:00.000Z', newId: () => 'unused' });
    const pointDueAtTitle = () => service.updateColumn(BACKLOG_STORE_ID, { projectId, columnId: DUE_COLUMN_ID, changes: { displayColumnId: TITLE_COLUMN_ID } });
    expect(pointDueAtTitle).not.toThrow();
    reimported.close();
  });
});
