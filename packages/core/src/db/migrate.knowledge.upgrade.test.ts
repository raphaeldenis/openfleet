import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';

it('upgrades 024 to knowledge storage while preserving existing projects', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const previousMigrations = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '025').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db, previousMigrations);
    db.exec("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Fleet', 'now')");

    applyMigrations(db);
    db.exec("INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir) VALUES ('project', 'fleet', '/fleet', '/fleet/.git')");
    db.exec("INSERT INTO knowledge (id, project_id, repo_key, area, fact, created_at) VALUES ('fact', 'project', 'fleet', 'architecture', 'hexagonal', 'now')");

    expect(db.prepare('SELECT name FROM projects').get()).toMatchObject({ name: 'Fleet' });
    expect(db.prepare('SELECT id FROM active_knowledge').all()).toEqual([{ id: 'fact' }]);
    expect(db.prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH 'hexagonal'").all()).toHaveLength(1);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get()).toMatchObject({ version: '025_knowledge' });
  } finally {
    db.close();
  }
});

it('enforces durable knowledge scope, authority, retirement and import ledger constraints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db);
    db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Fleet', 'now')");
    const register = db.prepare('INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir, authority) VALUES (?, ?, ?, ?, ?)');
    expect(() => register.run('missing', 'fleet', '/fleet', '/fleet/.git', 'postgres')).toThrow();
    expect(() => register.run('p', 'fleet', '/fleet', '/fleet/.git', 'native')).toThrow();
    register.run('p', 'fleet', '/fleet', '/fleet/.git', 'postgres');
    expect(() => register.run('p', 'duplicate', '/fleet', '/fleet/.git', 'postgres')).toThrow();
    expect(() => db.exec("INSERT INTO knowledge (id, project_id, repo_key, area, fact, created_at) VALUES ('a', 'p', 'unknown', 'area', 'fact', 'now')")).toThrow();
    expect(() => db.exec("INSERT INTO knowledge (id, project_id, repo_key, area, fact, created_at, retired_why) VALUES ('a', 'p', 'fleet', 'area', 'fact', 'now', 'reason')")).toThrow();
    db.exec("INSERT INTO knowledge (id, project_id, repo_key, area, fact, created_at, retired_at) VALUES ('a', 'p', 'fleet', 'area', 'fact', 'now', 'now')");
    db.exec("INSERT INTO knowledge_import_entries VALUES ('p', 'fleet', 'source', 'a', 'fingerprint', 'snapshot')");
    expect(() => db.exec("INSERT INTO knowledge_import_entries VALUES ('p', 'fleet', 'second', 'a', 'fingerprint', 'snapshot')")).toThrow();
    expect(() => db.exec("INSERT INTO knowledge_import_runs VALUES ('run', 'snapshot', 'now', -1, 0, 0, 0, 0)")).toThrow();
    expect(() => db.exec("DELETE FROM projects WHERE id = 'p'")).toThrow();
    expect(db.prepare('SELECT id FROM active_knowledge').all()).toEqual([]);
  } finally { db.close(); }
});
