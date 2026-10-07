import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { applyMigrations } from './migrate.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

it('upgrades a database from before the post-create hook: projects keep their data and have no hook configured', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const previousMigrations = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '024').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const databasePath = join(tempDirs.make('post-create-hook-upgrade-'), 'openfleet.db');
  let db = new DatabaseSync(databasePath);
  try {
    applyMigrations(db, previousMigrations);
    db.prepare("INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES ('project', 'Fleet', '/docs', 'now')").run();

    applyMigrations(db);
    db.close();
    db = new DatabaseSync(databasePath);
    const projects = new ProjectRepository(db);
    projects.update('project', { postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 });

    expect(projects.get('project')).toMatchObject({ id: 'project', name: 'Fleet', docsFolderPath: '/docs', postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 });
  } finally {
    db.close();
  }
});

it('leaves the hook columns empty for a project created before the upgrade', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Fleet', 'now')").run();

    expect(new ProjectRepository(db).get('project')).toEqual({ id: 'project', name: 'Fleet', docsFolderPath: null, createdAt: 'now' });
  } finally {
    db.close();
  }
});
