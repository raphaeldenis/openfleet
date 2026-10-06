import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';

it('upgrades a legacy database, configures its existing kanban and reopens without losing rows or history', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const previousMigrations = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '022').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const scratchRoot = join(process.cwd(), '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const databasePath = join(mkdtempSync(join(scratchRoot, 'kanban-config-upgrade-')), 'openfleet.db');
  let db = new DatabaseSync(databasePath);
  const scope = { projectId: 'project' };
  try {
    applyMigrations(db, previousMigrations);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', 'now')").run();
    const legacyRepo = new DataStoreRepository(db);
    legacyRepo.createStore({ id: 'store', projectId: 'project', displayName: 'Backlog', at: 'now' });
    const options = [{ id: 'todo', label: 'Todo' }, { id: 'done', label: 'Done' }];
    db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES ('status', 'store', 'Status', 'select', ?, 0, 'now')").run(JSON.stringify(options));
    legacyRepo.insertRow('store', { id: 'row', data: { status: 'todo' }, actor: { kind: 'human', label: 'You' }, at: 'now' });
    legacyRepo.insertView('store', { id: 'view', displayName: 'Board', viewType: 'kanban', config: { groupByColumnId: 'status' }, at: 'now' });
    db.close();

    db = new DatabaseSync(databasePath);
    applyMigrations(db);
    const service = new DataStoreService({ db, repo: new DataStoreRepository(db), clock: () => '2026-10-06T08:00:00Z', newId: () => 'unused' });
    expect(service.listViews('store', scope)[0]?.config).toEqual({ groupByColumnId: 'status' });
    const config = { groupByColumnId: 'status', cardTitleColumnId: 'status', cardFields: [], columnOrder: ['done'], showUngrouped: false };
    service.updateView('view', { ...scope, config });
    db.close();

    db = new DatabaseSync(databasePath);
    const repo = new DataStoreRepository(db);
    const reopenedService = new DataStoreService({ db, repo, clock: () => 'now', newId: () => 'unused' });
    expect(reopenedService.listViews('store', scope)[0]?.config).toEqual(config);
    expect(reopenedService.kanbanGroups('view', scope).map((group) => [group.option.id, group.rows.map((row) => row.id)])).toEqual([['done', []], ['todo', ['row']]]);
    expect(repo.rowHistory('row', scope)).toEqual([expect.objectContaining({ change: { kind: 'create' } })]);
  } finally {
    db.close();
  }
});
