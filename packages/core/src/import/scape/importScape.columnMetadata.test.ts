import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { importScape } from './importScape.js';
import {
  BACKLOG_STORE_ID, buildScapeFixture, editScapeNotes, PRIORITY_COLUMN_ID, STATUS_COLUMN_ID, STATUS_DONE_OPTION_ID, STATUS_TODO_OPTION_ID, TITLE_COLUMN_ID, DUE_COLUMN_ID,
  type ScapeFixture,
} from './scapeFixture.testkit.js';

const METADATA_COLUMNS = ['required INTEGER', 'displayColumnID TEXT', 'config TEXT', 'displayWidth INTEGER', 'wrapMode TEXT', 'wrapMaxLines INTEGER'];

interface ScapeColumnMetadata {
  columnId: string;
  required?: number; displayColumnID?: string; config?: string; displayWidth?: number; wrapMode?: string; wrapMaxLines?: number;
}

function fixtureWithColumnMetadata(metadata: ScapeColumnMetadata[]): ScapeFixture {
  const fixture = buildScapeFixture();
  editScapeNotes(fixture, (db) => {
    for (const column of METADATA_COLUMNS) db.exec(`ALTER TABLE data_store_column ADD COLUMN ${column}`);
    for (const { columnId, ...fields } of metadata) {
      const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ');
      db.prepare(`UPDATE data_store_column SET ${assignments} WHERE id = ?`).run(...Object.values(fields) as (string | number)[], columnId);
    }
  });
  return fixture;
}

const importOptionsOf = (fixture: ScapeFixture) => ({ scapeDir: fixture.scapeDir, home: join(fixture.workDir, 'target'), superpowersRoot: join(fixture.workDir, 'specs') });

function storedColumns(fixture: ScapeFixture) {
  const db = new DatabaseSync(join(fixture.workDir, 'target', 'openfleet.db'));
  try {
    return new DataStoreRepository(db).listColumns(BACKLOG_STORE_ID);
  } finally {
    db.close();
  }
}
const storedColumn = (fixture: ScapeFixture, columnId: string) => storedColumns(fixture).find((column) => column.id === columnId)!;

describe('Scape column metadata import', () => {
  it('keeps required, config, display column, width and wrap, and reimports them without change', () => {
    const fixture = fixtureWithColumnMetadata([
      { columnId: TITLE_COLUMN_ID, required: 1 },
      { columnId: PRIORITY_COLUMN_ID, displayColumnID: TITLE_COLUMN_ID, config: '{"symbol":"€","decimals":2}', displayWidth: 240, wrapMode: 'wrap', wrapMaxLines: 3 },
    ]);

    const first = importScape(importOptionsOf(fixture));
    const second = importScape(importOptionsOf(fixture));

    expect(storedColumn(fixture, TITLE_COLUMN_ID)).toMatchObject({ required: true });
    expect(storedColumn(fixture, PRIORITY_COLUMN_ID)).not.toHaveProperty('required');
    expect(storedColumn(fixture, PRIORITY_COLUMN_ID)).toMatchObject({
      displayColumnId: TITLE_COLUMN_ID, config: { symbol: '€', decimals: 2 }, displayWidth: 240, wrap: { mode: 'wrap', maxLines: 3 },
    });
    expect(first.droppedColumnMetadata).toEqual([]);
    expect(second.counts.columns).toMatchObject({ updated: 0, conflict: 0, alreadyPresent: 4 });
  });

  it('applies a later Scape change of the metadata to a column OpenFleet did not edit', () => {
    const fixture = fixtureWithColumnMetadata([{ columnId: TITLE_COLUMN_ID, required: 1, displayWidth: 200 }]);
    importScape(importOptionsOf(fixture));
    editScapeNotes(fixture, (db) => db.prepare('UPDATE data_store_column SET required = 0, displayWidth = 300 WHERE id = ?').run(TITLE_COLUMN_ID));

    const report = importScape(importOptionsOf(fixture));

    expect(storedColumn(fixture, TITLE_COLUMN_ID)).not.toHaveProperty('required');
    expect(storedColumn(fixture, TITLE_COLUMN_ID)).toMatchObject({ displayWidth: 300 });
    expect(report.counts.columns).toMatchObject({ updated: 1, conflict: 0 });
  });

  it('imports a Scape source that has none of the metadata fields', () => {
    const fixture = buildScapeFixture();

    const report = importScape(importOptionsOf(fixture));

    expect(storedColumn(fixture, TITLE_COLUMN_ID)).not.toHaveProperty('required');
    expect(storedColumn(fixture, TITLE_COLUMN_ID)).not.toHaveProperty('displayWidth');
    expect(report.droppedColumnMetadata).toEqual([]);
  });

  it('drops a display column that is unknown or closes a cycle and reports each', () => {
    const fixture = fixtureWithColumnMetadata([
      { columnId: TITLE_COLUMN_ID, displayColumnID: PRIORITY_COLUMN_ID },
      { columnId: PRIORITY_COLUMN_ID, displayColumnID: DUE_COLUMN_ID },
      { columnId: DUE_COLUMN_ID, displayColumnID: TITLE_COLUMN_ID },
      { columnId: STATUS_COLUMN_ID, displayColumnID: 'column-of-another-store' },
    ]);

    const report = importScape(importOptionsOf(fixture));

    const keptReferences = storedColumns(fixture).filter((column) => column.displayColumnId !== undefined).map((column) => column.id);
    expect(keptReferences).toEqual([TITLE_COLUMN_ID, PRIORITY_COLUMN_ID]);
    expect(report.droppedColumnMetadata).toEqual(expect.arrayContaining([
      { columnId: DUE_COLUMN_ID, field: 'displayColumnID', value: TITLE_COLUMN_ID },
      { columnId: STATUS_COLUMN_ID, field: 'displayColumnID', value: 'column-of-another-store' },
    ]));
    expect(report.droppedColumnMetadata).toHaveLength(2);
  });

  it('reports a required flag that is neither 0 nor 1 instead of silently reading it as 0', () => {
    const fixture = fixtureWithColumnMetadata([{ columnId: TITLE_COLUMN_ID, required: 2 }]);

    const report = importScape(importOptionsOf(fixture));

    expect(storedColumn(fixture, TITLE_COLUMN_ID)).not.toHaveProperty('required');
    expect(report.droppedColumnMetadata).toEqual([{ columnId: TITLE_COLUMN_ID, field: 'required', value: '2' }]);
  });

  it('drops metadata OpenFleet cannot hold and reports it', () => {
    const fixture = fixtureWithColumnMetadata([
      { columnId: PRIORITY_COLUMN_ID, displayWidth: 5000, config: '{"unknownSetting":1}', wrapMode: 'truncate' },
      { columnId: TITLE_COLUMN_ID, config: '{"decimals":2}' },
    ]);

    const report = importScape(importOptionsOf(fixture));

    expect(storedColumn(fixture, PRIORITY_COLUMN_ID)).not.toHaveProperty('displayWidth');
    expect(storedColumn(fixture, PRIORITY_COLUMN_ID)).not.toHaveProperty('config');
    expect(storedColumn(fixture, PRIORITY_COLUMN_ID)).not.toHaveProperty('wrap');
    expect(storedColumn(fixture, TITLE_COLUMN_ID)).not.toHaveProperty('config');
    expect(report.droppedColumnMetadata).toEqual(expect.arrayContaining([
      { columnId: PRIORITY_COLUMN_ID, field: 'displayWidth', value: '5000' },
      { columnId: PRIORITY_COLUMN_ID, field: 'config', value: '{"unknownSetting":1}' },
      { columnId: TITLE_COLUMN_ID, field: 'config', value: '{"decimals":2}' },
    ]));
    expect(report.droppedColumnMetadata).toHaveLength(3);
  });
});

describe('Scape option colors import', () => {
  const importWithOptionColors = (colors: { todo: string; done: string }) => {
    const fixture = buildScapeFixture();
    editScapeNotes(fixture, (db) => db.prepare('UPDATE data_store_column SET options = ? WHERE id = ?').run(
      JSON.stringify([
        { id: STATUS_TODO_OPTION_ID, label: 'todo', color: colors.todo },
        { id: STATUS_DONE_OPTION_ID, label: 'done', color: colors.done },
      ]),
      STATUS_COLUMN_ID,
    ));
    const report = importScape(importOptionsOf(fixture));
    return { report, options: storedColumn(fixture, STATUS_COLUMN_ID).options };
  };

  it('keeps hex colors as they are', () => {
    const { report, options } = importWithOptionColors({ todo: '#3B82F6', done: '#00ff0080' });

    expect(options).toEqual([
      { id: STATUS_TODO_OPTION_ID, label: 'todo', color: '#3B82F6' },
      { id: STATUS_DONE_OPTION_ID, label: 'done', color: '#00ff0080' },
    ]);
    expect(report.droppedOptionColors).toEqual([]);
  });

  it('converts a standard CSS color name to hex whatever its case', () => {
    const { report, options } = importWithOptionColors({ todo: 'Red', done: 'navy' });

    expect(options).toEqual([
      { id: STATUS_TODO_OPTION_ID, label: 'todo', color: '#ff0000' },
      { id: STATUS_DONE_OPTION_ID, label: 'done', color: '#000080' },
    ]);
    expect(report.droppedOptionColors).toEqual([]);
  });

  it('drops a color that is neither hex nor a standard name and reports it with the option', () => {
    const { report, options } = importWithOptionColors({ todo: 'rgb(1, 2, 3)', done: '#12' });

    expect(options).toEqual([
      { id: STATUS_TODO_OPTION_ID, label: 'todo' },
      { id: STATUS_DONE_OPTION_ID, label: 'done' },
    ]);
    expect(report.droppedOptionColors).toEqual([
      { columnId: STATUS_COLUMN_ID, optionId: STATUS_TODO_OPTION_ID, color: 'rgb(1, 2, 3)' },
      { columnId: STATUS_COLUMN_ID, optionId: STATUS_DONE_OPTION_ID, color: '#12' },
    ]);
  });

  it('drops a color named like an inherited object property and reports it', () => {
    const { report, options } = importWithOptionColors({ todo: 'constructor', done: '__proto__' });

    expect(options).toEqual([
      { id: STATUS_TODO_OPTION_ID, label: 'todo' },
      { id: STATUS_DONE_OPTION_ID, label: 'done' },
    ]);
    expect(report.droppedOptionColors).toEqual([
      { columnId: STATUS_COLUMN_ID, optionId: STATUS_TODO_OPTION_ID, color: 'constructor' },
      { columnId: STATUS_COLUMN_ID, optionId: STATUS_DONE_OPTION_ID, color: '__proto__' },
    ]);
  });
});
