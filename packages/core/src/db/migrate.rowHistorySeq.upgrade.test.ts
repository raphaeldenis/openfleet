import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';

const HUMAN = { kind: 'human', label: 'You' } as const;

function databaseBeforeRowHistorySeq(): { db: DatabaseSync; repo: DataStoreRepository } {
  const directory = new URL('./migrations/', import.meta.url);
  const previousMigrations = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '043').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const scratchRoot = join(process.cwd(), '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const db = new DatabaseSync(join(mkdtempSync(join(scratchRoot, 'row-history-seq-')), 'openfleet.db'));
  applyMigrations(db, previousMigrations);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', 'now')").run();
  const repo = new DataStoreRepository(db);
  repo.createStore({ id: 'store', projectId: 'project', displayName: 'Backlog', at: 'now' });
  return { db, repo };
}

it('numbers the existing history in its current order and keeps every entry', () => {
  const { db, repo } = databaseBeforeRowHistorySeq();
  try {
    repo.insertRow('store', { id: 'row', data: {}, actor: HUMAN, at: 'same-instant' });
    repo.deleteRow('row', { storeId: 'store', actor: HUMAN, at: 'same-instant' });

    applyMigrations(db);

    const newestFirst = repo.rowHistory('row', { projectId: 'project' });
    expect(newestFirst.map((entry) => entry.change)).toEqual([{ kind: 'delete' }, { kind: 'create' }]);
    expect(newestFirst.map((entry) => entry.seq)).toEqual([2, 1]);
  } finally {
    db.close();
  }
});

it('keeps seq stable across a VACUUM and never reuses the seq of a deleted entry', () => {
  const { db, repo } = databaseBeforeRowHistorySeq();
  try {
    applyMigrations(db);
    repo.insertRow('store', { id: 'row', data: {}, actor: HUMAN, at: 't1' });
    repo.insertRow('store', { id: 'row-2', data: {}, actor: HUMAN, at: 't2' });
    const seqsBefore = repo.rowHistory('row-2', { projectId: 'project' }).map((entry) => entry.seq);

    db.exec('VACUUM');

    expect(repo.rowHistory('row-2', { projectId: 'project' }).map((entry) => entry.seq)).toEqual(seqsBefore);
    db.prepare("DELETE FROM ds_row_history WHERE row_id = 'row-2'").run();
    repo.insertRow('store', { id: 'row-3', data: {}, actor: HUMAN, at: 't3' });
    const [seqAfterDeletion] = repo.rowHistory('row-3', { projectId: 'project' }).map((entry) => entry.seq);
    expect(seqAfterDeletion).toBeGreaterThan(seqsBefore[0]!);
  } finally {
    db.close();
  }
});
