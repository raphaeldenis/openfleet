import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { importScape } from './importScape.js';
import {
  BACKLOG_ROW_ID, BACKLOG_STORE_ID, buildScapeFixture, DUE_COLUMN_ID, editScapeDatastore, editScapeNotes,
  PRIORITY_COLUMN_ID, scapeBacklogTable, scapeTitleCellKey, TITLE_COLUMN_ID,
} from './scapeFixture.testkit.js';

const cellKey = (id: string) => `col_${id.replaceAll('-', '')}`;

it('preserves rich Scape formats, values and datetime history and reimports idempotently', () => {
  const fixture = buildScapeFixture();
  const home = join(fixture.workDir, 'target');
  const options = { scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'specs') };
  editScapeNotes(fixture, (db) => {
    const update = db.prepare('UPDATE data_store_column SET format = ? WHERE id = ?');
    update.run('longText', TITLE_COLUMN_ID);
    update.run('rank', PRIORITY_COLUMN_ID);
    update.run('datetime', DUE_COLUMN_ID);
    db.prepare("INSERT INTO data_store_column (id, storeID, displayName, columnType, sortOrder, format) VALUES ('url', ?, 'URL', 'text', 4, 'url')").run(BACKLOG_STORE_ID);
  });
  editScapeDatastore(fixture, (db) => {
    db.exec(`ALTER TABLE ${scapeBacklogTable} ADD COLUMN col_url TEXT`);
    db.prepare(`UPDATE ${scapeBacklogTable} SET col_url = ?, ${scapeTitleCellKey} = ? WHERE row_id = ?`).run('https://example.com', 'First\nSecond', BACKLOG_ROW_ID);
    db.prepare('INSERT INTO row_change_log (storeID, rowID, kind, oldValues, newValues, schemaVersion, source, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(BACKLOG_STORE_ID, BACKLOG_ROW_ID, 'update', JSON.stringify({ [cellKey(DUE_COLUMN_ID)]: 1790246214 }), JSON.stringify({ [cellKey(DUE_COLUMN_ID)]: 1790246314 }), 'mcp', 1790246314);
  });

  const first = importScape(options);
  const second = importScape(options);
  const db = new DatabaseSync(join(home, 'openfleet.db'));
  try {
    const repo = new DataStoreRepository(db);
    expect(repo.listColumns(BACKLOG_STORE_ID).map((column) => column.format)).toEqual(['longText', undefined, 'rank', 'datetime', 'url']);
    expect(repo.listRows(BACKLOG_STORE_ID).find((row) => row.id === BACKLOG_ROW_ID)?.data).toMatchObject({
      [TITLE_COLUMN_ID]: 'First\nSecond', [PRIORITY_COLUMN_ID]: 1, [DUE_COLUMN_ID]: new Date(1790246314000).toISOString(), url: 'https://example.com',
    });
    expect(repo.rowHistory(BACKLOG_ROW_ID, { projectId: repo.findStore(BACKLOG_STORE_ID)!.projectId })).toContainEqual(expect.objectContaining({
      change: { [DUE_COLUMN_ID]: { from: new Date(1790246214000).toISOString(), to: new Date(1790246314000).toISOString() } },
    }));
    expect(first.droppedColumnFormats).toEqual([]);
    expect(second.counts.columns).toMatchObject({ updated: 0, conflict: 0, alreadyPresent: 5 });
  } finally {
    db.close();
  }
});

it('adds formats to legacy ledger columns while preserving local column edits', () => {
  const fixture = buildScapeFixture();
  const home = join(fixture.workDir, 'target');
  const options = { scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'specs') };
  importScape(options);
  const db = new DatabaseSync(join(home, 'openfleet.db'));
  try {
    for (const id of [TITLE_COLUMN_ID, PRIORITY_COLUMN_ID]) {
      const legacyRecord = db.prepare('SELECT store_id, display_name, column_type, options_json, sort_order, created_at FROM ds_columns WHERE id = ?').get(id)!;
      const sortedEntries = Object.entries(legacyRecord).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      const legacyHash = createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex');
      db.prepare("UPDATE scape_import_ledger SET record_hash = ? WHERE kind = 'column' AND id = ?").run(legacyHash, id);
    }
    db.prepare('UPDATE ds_columns SET display_name = ? WHERE id = ?').run('Local title', TITLE_COLUMN_ID);
  } finally {
    db.close();
  }
  editScapeNotes(fixture, (source) => {
    source.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run('rank', PRIORITY_COLUMN_ID);
    source.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run('longText', TITLE_COLUMN_ID);
  });

  const report = importScape(options);
  const target = new DatabaseSync(join(home, 'openfleet.db'));
  try {
    const repo = new DataStoreRepository(target);
    expect(repo.listColumns(BACKLOG_STORE_ID)).toContainEqual(expect.objectContaining({ id: PRIORITY_COLUMN_ID, format: 'rank' }));
    expect(repo.listColumns(BACKLOG_STORE_ID)).toContainEqual(expect.objectContaining({ id: TITLE_COLUMN_ID, displayName: 'Local title' }));
    expect(report.counts.columns).toMatchObject({ updated: 1, conflict: 1 });
  } finally {
    target.close();
  }
});

it('reports unsupported or incompatible source formats without reinterpreting values', () => {
  const fixture = buildScapeFixture();
  editScapeNotes(fixture, (db) => {
    db.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run('rank', TITLE_COLUMN_ID);
    db.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run('stars', PRIORITY_COLUMN_ID);
  });

  const report = importScape({ scapeDir: fixture.scapeDir, home: join(fixture.workDir, 'target'), superpowersRoot: join(fixture.workDir, 'specs') });

  expect(report.droppedColumnFormats).toEqual(expect.arrayContaining([
    { columnId: TITLE_COLUMN_ID, format: 'rank' }, { columnId: PRIORITY_COLUMN_ID, format: 'stars' },
  ]));
});
