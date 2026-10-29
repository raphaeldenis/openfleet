import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const sharedRepoDownMigration = new URL('./migrations-down/054_project_shared_repo.down.sql', import.meta.url);

const migrationsUpTo = (lastFileName: string) =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql') && fileName <= lastFileName)
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const databaseUpTo = (lastFileName: string): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsUpTo(lastFileName));
  return db;
};

const columnNamesOfProjects = (db: DatabaseSync): string[] =>
  (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(({ name }) => name);

describe('migration 054, the shared repo setting', () => {
  it('leaves every existing project with a repository that is not shared', () => {
    const db = databaseUpTo('053_review_finding_repro.sql');
    db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Fleet', '2026-10-29T10:00:00.000Z')");
    applyMigrations(db, migrationsUpTo('054_project_shared_repo.sql'));

    const project = db.prepare("SELECT shared_repo FROM projects WHERE id = 'p1'").get() as { shared_repo: number };

    expect(project.shared_repo).toBe(0);
  });

  it('is undone by its down migration, which drops only shared_repo', () => {
    const databaseBefore054 = databaseUpTo('053_review_finding_repro.sql');
    const databaseAfter054 = databaseUpTo('054_project_shared_repo.sql');

    databaseAfter054.exec(readFileSync(sharedRepoDownMigration, 'utf8'));

    expect(columnNamesOfProjects(databaseAfter054)).toEqual(columnNamesOfProjects(databaseBefore054));
  });
});
