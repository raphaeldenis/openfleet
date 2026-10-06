import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';

it('upgrades a migration 021 database without losing columns, rows, views or history', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const previousMigrations = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '022').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const scratchRoot = join(process.cwd(), '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const databasePath = join(mkdtempSync(join(scratchRoot, 'column-format-upgrade-')), 'openfleet.db');
  let db = new DatabaseSync(databasePath);
  try {
    applyMigrations(db, previousMigrations);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', 'now')").run();
    const repo = new DataStoreRepository(db);
    repo.createStore({ id: 'store', projectId: 'project', displayName: 'Backlog', at: 'now' });
    db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, sort_order, created_at) VALUES ('title', 'store', 'Title', 'text', 0, 'now')").run();
    repo.insertRow('store', { id: 'row', data: { title: 'Keep me' }, actor: { kind: 'human', label: 'You' }, at: 'now' });
    repo.insertView('store', { id: 'view', displayName: 'Grid', viewType: 'grid', config: {}, at: 'now' });

    applyMigrations(db);
    const service = new DataStoreService({ db, repo, clock: () => '2026-10-06T08:00:00Z', newId: () => 'rank' });
    service.addColumn('store', { projectId: 'project', displayName: 'Rank', columnType: 'number', format: 'rank' });

    db.close();
    db = new DatabaseSync(databasePath);
    const reopenedRepo = new DataStoreRepository(db);

    expect(reopenedRepo.listColumns('store')).toEqual([
      expect.objectContaining({ id: 'title', columnType: 'text' }),
      expect.objectContaining({ id: 'rank', columnType: 'number', format: 'rank' }),
    ]);
    expect(reopenedRepo.listColumns('store')[0]).not.toHaveProperty('format');
    expect(reopenedRepo.listRows('store')).toEqual([expect.objectContaining({ data: { title: 'Keep me' } })]);
    expect(reopenedRepo.listViews('store')).toEqual([expect.objectContaining({ id: 'view' })]);
    expect(reopenedRepo.rowHistory('row', { projectId: 'project' })).toEqual([expect.objectContaining({ change: { kind: 'create' } })]);
  } finally {
    db.close();
  }
});
