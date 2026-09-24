import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationSource {
  version: string;
  sql: string;
}

function readMigrationSources(dir: string): MigrationSource[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ version: file.replace(/\.sql$/, ''), sql: readFileSync(join(dir, file), 'utf8') }));
}

// ponytail: sources defaults to the real migrations directory; tests inject a list directly to
// exercise a failing statement without writing fixture files to disk.
export function applyMigrations(db: DatabaseSync, sources: MigrationSource[] = readMigrationSources(migrationsDir)): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version));
  for (const { version, sql } of sources) {
    if (applied.has(version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      db.exec('COMMIT');
      applied.add(version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
