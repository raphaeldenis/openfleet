import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationSource {
  version: string;
  sql: string;
}

function readMigrationSources(dir: string): MigrationSource[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ version: file.replace(/\.sql$/, ''), sql: readFileSync(join(dir, file), 'utf8') }));
}

const TRANSACTION_CONTROL_STATEMENT = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

// ponytail: strips CREATE TRIGGER/VIEW bodies (BEGIN…END blocks) before scanning for bare
// transaction-control statements, so a trigger's own BEGIN/END doesn't false-positive. Ceiling:
// a regex, not a real parser — an oddly nested body can still slip through; upgrade to a proper
// SQL statement splitter if that ever bites.
function containsTransactionControl(sql: string): boolean {
  const withoutTriggerBodies = sql.replace(/\bBEGIN\b[\s\S]*?\bEND\b/gi, '');
  return withoutTriggerBodies.split(';').some((statement) => TRANSACTION_CONTROL_STATEMENT.test(statement));
}

// ponytail: `sources` exists only so tests can inject a broken migration; the default reads
// migrations/*.sql. Upgrade: a MigrationSource provider if a second real source ever appears.
export function applyMigrations(db: DatabaseSync, sources: MigrationSource[] = readMigrationSources(migrationsDir)): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version));

  for (const { version, sql } of sources) {
    if (applied.has(version)) continue;
    if (containsTransactionControl(sql)) {
      throw new Error(`migration ${version} contains a transaction-control statement; migrations must not manage their own transaction`);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const appliedByAnotherProcess = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version) !== undefined;
      if (appliedByAnotherProcess) {
        db.exec('COMMIT');
        applied.add(version);
        continue;
      }

      db.exec(sql);
      if (!db.isTransaction) {
        throw new Error(`migration ${version} ended the transaction`);
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      db.exec('COMMIT');
      applied.add(version);
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // transaction already gone (e.g. the migration's own trigger rolled it back); nothing to undo
        }
      }
      throw error;
    }
  }
}
