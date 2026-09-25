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

// ponytail: comments and quoted literals are the only ways SQLite lets a statement hide or fake a
// token, so a single left-to-right pass that blanks them out (keeping delimiters, so positions and
// statement counts stay sane) is enough to make a later `;`-split safe to scan for keywords.
function stripCommentsAndStrings(sql: string): string {
  let stripped = '';
  let i = 0;
  while (i < sql.length) {
    const twoChars = sql.slice(i, i + 2);
    if (twoChars === '--') {
      while (i < sql.length && sql[i] !== '\n') i++;
      stripped += ' ';
      continue;
    }
    if (twoChars === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      stripped += ' ';
      continue;
    }

    const quoteChar = sql[i];
    const closingChar = quoteChar === '[' ? ']' : quoteChar;
    if (quoteChar === "'" || quoteChar === '"' || quoteChar === '`' || quoteChar === '[') {
      i++;
      while (i < sql.length) {
        if (sql[i] === closingChar && sql[i + 1] === closingChar && closingChar !== ']') {
          i += 2;
          continue;
        }
        if (sql[i] === closingChar) {
          i++;
          break;
        }
        i++;
      }
      stripped += quoteChar === '[' ? '[]' : `${quoteChar}${quoteChar}`;
      continue;
    }

    stripped += sql[i];
    i++;
  }
  return stripped;
}

const TRANSACTION_CONTROL_KEYWORDS = ['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'];
const CREATE_TRIGGER_STATEMENT = /^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\b/;

function isTransactionControlStatement(statement: string): boolean {
  return TRANSACTION_CONTROL_KEYWORDS.some((keyword) => statement === keyword || statement.startsWith(`${keyword} `));
}

function closesTriggerBody(statement: string): boolean {
  return statement === 'END' || statement.startsWith('END ');
}

// ponytail: migrations own no transaction control — applyMigrations owns the BEGIN IMMEDIATE/COMMIT
// boundary — so once comments and literals are stripped, no top-level statement may start with one
// of these keywords. A CREATE TRIGGER's own BEGIN…END body is tracked and skipped, not scanned.
function containsTransactionControl(sql: string): boolean {
  const statements = stripCommentsAndStrings(sql)
    .split(';')
    .map((statement) => statement.trim().toUpperCase())
    .filter((statement) => statement.length > 0);

  let insideTriggerBody = false;
  for (const statement of statements) {
    if (insideTriggerBody) {
      if (closesTriggerBody(statement)) insideTriggerBody = false;
      continue;
    }
    if (CREATE_TRIGGER_STATEMENT.test(statement) && statement.includes(' BEGIN')) {
      insideTriggerBody = true;
      continue;
    }
    if (isTransactionControlStatement(statement)) return true;
  }
  return false;
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
