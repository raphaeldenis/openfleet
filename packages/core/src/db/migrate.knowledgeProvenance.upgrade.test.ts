import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';

it('upgrades 025 to import provenance without rewriting knowledge or historical runs', () => {
  const directory = new URL('./migrations/', import.meta.url);
  const previous = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '026').sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
  const db = new DatabaseSync(':memory:');
  try {
    applyMigrations(db, previous);
    db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Fleet', 'now')");
    db.exec("INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir) VALUES ('p', 'repo', '/repo', '/repo/.git')");
    db.exec("INSERT INTO knowledge (id, project_id, repo_key, area, fact, created_at) VALUES ('fact', 'p', 'repo', 'area', 'text', 'now')");
    db.exec("INSERT INTO knowledge_import_runs VALUES ('historic', 'snapshot', 'now', 1, 1, 0, 0, 0)");
    const facts = db.prepare('SELECT * FROM knowledge').all();

    applyMigrations(db);

    expect(db.prepare('SELECT * FROM knowledge').all()).toEqual(facts);
    expect(db.prepare('SELECT id, snapshot_digest, mem02_acceptance FROM knowledge_import_runs').all()).toEqual([{ id: 'historic', snapshot_digest: null, mem02_acceptance: null }]);
    db.prepare('INSERT INTO knowledge_import_mappings (run_id, source_repo, project_id, repo_key, canonical_root, git_common_dir) VALUES (?, ?, ?, ?, ?, ?)').run('historic', 'source', 'p', 'repo', '/repo', '/repo/.git');
    expect(() => db.exec("DELETE FROM projects WHERE id = 'p'")).toThrow();
    expect(() => db.exec("DELETE FROM knowledge_import_runs WHERE id = 'historic'")).toThrow();
    expect(db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'knowledge_import_mappings'").get()).toEqual({ strict: 1 });
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: '026_knowledge_import_provenance' });
  } finally { db.close(); }
});
