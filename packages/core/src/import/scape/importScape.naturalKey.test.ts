import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { hashOfValues } from './scapeLedger.js';
import { BACKLOG_STORE_ID, buildScapeFixture, editScapeNotes, LOG_STORE_ID, STATUS_COLUMN_ID, TITLE_COLUMN_ID, type ScapeFixture } from './scapeFixture.testkit.js';

interface StoredStore { project_id: string; display_name: string; created_at: string; natural_key_column_id: string | null }

describe('importScape natural key of a data store', () => {
  let fixture: ScapeFixture;
  let home: string;

  const run = () =>
    importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), scratchRoot: join(fixture.workDir, 'scratch') });

  const withTarget = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const naturalKeyOf = (storeId: string) =>
    withTarget((db) => (db.prepare('SELECT natural_key_column_id AS key FROM data_stores WHERE id = ?').get(storeId) as { key: string | null }).key);
  const setNaturalKeyInScape = (storeId: string, columnId: string | null) =>
    editScapeNotes(fixture, (db) => db.prepare('UPDATE data_store_meta SET naturalKeyColumnID = ? WHERE id = ?').run(columnId, storeId));
  const setNaturalKeyInOpenFleet = (storeId: string, columnId: string | null) =>
    withTarget((db) => db.prepare('UPDATE data_stores SET natural_key_column_id = ? WHERE id = ?').run(columnId, storeId));
  const rewindLedgerToTheShapeBeforeNaturalKeys = (storeId: string) =>
    withTarget((db) => {
      const stored = db.prepare('SELECT project_id, display_name, created_at, natural_key_column_id FROM data_stores WHERE id = ?').get(storeId) as unknown as StoredStore;
      const shapeBeforeNaturalKeys = hashOfValues({ project_id: stored.project_id, display_name: stored.display_name, created_at: stored.created_at });
      db.prepare("UPDATE scape_import_ledger SET record_hash = ? WHERE kind = 'data_store' AND id = ?").run(shapeBeforeNaturalKeys, storeId);
    });

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    mkdirSync(join(fixture.workDir, 'scratch'));
    mkdirSync(join(fixture.workDir, 'superpowers', 'openfleet'), { recursive: true });
  });

  it('is imported from the natural key column of the Scape store', () => {
    setNaturalKeyInScape(BACKLOG_STORE_ID, TITLE_COLUMN_ID);

    run();

    expect(naturalKeyOf(BACKLOG_STORE_ID)).toBe(TITLE_COLUMN_ID);
  });

  it('stays empty for a Scape store that has none', () => {
    run();

    expect(naturalKeyOf(BACKLOG_STORE_ID)).toBeNull();
  });

  it('reaches a store imported before natural keys existed and left untouched in OpenFleet, as an update', () => {
    run();
    rewindLedgerToTheShapeBeforeNaturalKeys(BACKLOG_STORE_ID);
    setNaturalKeyInScape(BACKLOG_STORE_ID, TITLE_COLUMN_ID);

    const report = run();

    expect(naturalKeyOf(BACKLOG_STORE_ID)).toBe(TITLE_COLUMN_ID);
    expect(report.counts.dataStores).toMatchObject({ updated: 1, conflict: 0 });
  });

  it('finds a store imported before natural keys existed, with no key in Scape either, already present', () => {
    run();
    rewindLedgerToTheShapeBeforeNaturalKeys(BACKLOG_STORE_ID);
    rewindLedgerToTheShapeBeforeNaturalKeys(LOG_STORE_ID);

    const report = run();

    expect(report.counts.dataStores).toMatchObject({ updated: 0, conflict: 0, alreadyPresent: 2 });
  });

  it('finds the key again on a run that changes nothing', () => {
    setNaturalKeyInScape(BACKLOG_STORE_ID, TITLE_COLUMN_ID);
    run();

    const report = run();

    expect(report.counts.dataStores).toMatchObject({ updated: 0, conflict: 0, written: 0 });
  });

  it('keeps a key set in OpenFleet when Scape names another column', () => {
    run();
    setNaturalKeyInOpenFleet(BACKLOG_STORE_ID, TITLE_COLUMN_ID);
    setNaturalKeyInScape(BACKLOG_STORE_ID, STATUS_COLUMN_ID);

    const report = run();

    expect(naturalKeyOf(BACKLOG_STORE_ID)).toBe(TITLE_COLUMN_ID);
    expect(report.counts.dataStores).toMatchObject({ conflict: 1, updated: 0 });
  });

  it('does not clear a key set in OpenFleet on a store that has none in Scape', () => {
    run();
    setNaturalKeyInOpenFleet(BACKLOG_STORE_ID, TITLE_COLUMN_ID);

    const report = run();

    expect(naturalKeyOf(BACKLOG_STORE_ID)).toBe(TITLE_COLUMN_ID);
    expect(report.counts.dataStores).toMatchObject({ conflict: 1, updated: 0 });
  });
});
