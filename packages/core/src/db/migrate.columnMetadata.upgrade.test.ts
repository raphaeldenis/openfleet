import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';

it('upgrades a database before the column metadata migration keeping its columns, and persists the metadata after a reopen', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const previousMigrations = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '048').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const scratchRoot = join(process.cwd(), '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const databasePath = join(mkdtempSync(join(scratchRoot, 'column-metadata-upgrade-')), 'openfleet.db');
  let db = new DatabaseSync(databasePath);
  try {
    applyMigrations(db, previousMigrations);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', 'now')").run();
    new DataStoreRepository(db).createStore({ id: 'store', projectId: 'project', displayName: 'Backlog', at: 'now' });
    db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, sort_order, created_at) VALUES ('qty', 'store', 'Qty', 'number', 0, 'now')").run();

    applyMigrations(db);
    const service = new DataStoreService({ db, repo: new DataStoreRepository(db), clock: () => '2026-10-29T08:00:00Z', newId: () => 'unused' });
    const upgraded = new DataStoreRepository(db).listColumns('store')[0];
    service.updateColumn('store', { projectId: 'project', columnId: 'qty', changes: { required: true, displayWidth: 120, wrap: { mode: 'wrap', maxLines: 2 }, config: { decimals: 2 } } });

    db.close();
    db = new DatabaseSync(databasePath);

    expect(upgraded).not.toHaveProperty('required');
    expect(new DataStoreRepository(db).listColumns('store')[0]).toMatchObject({ id: 'qty', required: true, displayWidth: 120, wrap: { mode: 'wrap', maxLines: 2 }, config: { decimals: 2 } });
  } finally {
    db.close();
  }
});

it('refuses an out-of-range width or wrap line cap written straight to the table', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const migrations = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db, migrations);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', 'now')").run();
    db.prepare("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('store', 'project', 'S', 'now', 'now')").run();
    const insertWithWidth = (id: string, width: number) => db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, sort_order, created_at, display_width) VALUES (?, 'store', ?, 'text', 0, 'now', ?)").run(id, id, width);
    const insertWithLinesAndNoWrap = () => db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, sort_order, created_at, wrap_max_lines) VALUES ('lines', 'store', 'lines', 'text', 0, 'now', 2)").run();

    expect(() => insertWithWidth('narrow', 59)).toThrow();
    expect(() => insertWithWidth('wide', 1201)).toThrow();
    expect(() => insertWithLinesAndNoWrap()).toThrow();
  } finally {
    db.close();
  }
});
