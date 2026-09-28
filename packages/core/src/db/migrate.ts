import { createHash } from 'node:crypto';
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
const CREATE_TRIGGER_STATEMENT = /^CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/;

const TRANSACTION_CONTROL_STATEMENT = new RegExp(`^(?:${TRANSACTION_CONTROL_KEYWORDS.join('|')})(?:\\s|$)`, 'i');
const TRIGGER_BODY_CLOSING_STATEMENT = /^END(?:\s|$)/i;

function isTransactionControlStatement(statement: string): boolean {
  return TRANSACTION_CONTROL_STATEMENT.test(statement);
}

function closesTriggerBody(statement: string): boolean {
  return TRIGGER_BODY_CLOSING_STATEMENT.test(statement);
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

// A checkout can hand back a migration file with a BOM and/or CRLF line endings (Windows, a careless
// editor) despite .gitattributes pinning `text eol=lf`: normalized away before hashing so line-ending
// drift alone never trips reconcileChecksums' "edited after being applied" guard.
function normalizeForChecksum(sql: string): string {
  const withoutBom = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  return withoutBom.replace(/\r\n?/g, '\n');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(normalizeForChecksum(text)).digest('hex');
}

function hasChecksumColumn(db: DatabaseSync): boolean {
  return (db.prepare('PRAGMA table_info(schema_migrations)').all() as { name: string }[]).some((column) => column.name === 'checksum');
}

// A DB naming an applied version this checkout has no file for is either newer than the running code
// (another branch/worktree applied it first, sharing the same db file per db/README.md) or was
// tampered with — refusing beats silently running against a schema nothing here has verified. Only
// checked against the real on-disk migrations (never against a caller-supplied `sources` override,
// which exists solely so tests can inject a migration that was never really "shipped").
function rejectUnknownAppliedVersions(applied: Set<string>, knownSources: MigrationSource[]): void {
  const knownVersions = new Set(knownSources.map((s) => s.version));
  const unknownVersions = [...applied].filter((version) => !knownVersions.has(version)).sort();
  if (unknownVersions.length > 0) {
    throw new Error(`database has migrations this code doesn't know: ${unknownVersions.join(', ')}; refusing to start on a schema newer than the code`);
  }
}

// Migrations recorded before the checksum column existed (008_schema_migrations_checksum.sql) have no
// checksum yet: backfilled here rather than failing startup. One that already has a checksum and no
// longer matches its file's current content means the applied migration was edited after the fact —
// refused, for the same reason an unknown newer version is refused above. Only reconciled against
// `sources` (see rejectUnknownAppliedVersions): a version outside it is silently left alone rather than
// compared against unrelated SQL, since it was never claimed to be that version's real source anyway.
function reconcileChecksums(db: DatabaseSync, sources: MigrationSource[]): void {
  if (!hasChecksumColumn(db)) return;
  const sqlByVersion = new Map<string, string>();
  for (const source of sources) if (!sqlByVersion.has(source.version)) sqlByVersion.set(source.version, source.sql);

  const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: string; checksum: string | null }[];
  for (const row of rows) {
    const sql = sqlByVersion.get(row.version);
    if (sql === undefined) continue;
    const currentChecksum = sha256Hex(sql);
    if (row.checksum === null) {
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(currentChecksum, row.version);
      continue;
    }
    if (row.checksum !== currentChecksum) {
      throw new Error(`migration ${row.version} was applied with SQL that no longer matches the file on disk now (checksum mismatch); migrations must not be edited after being applied`);
    }
  }
}

// ponytail: `sources` exists only so tests can inject a broken migration; the default reads
// migrations/*.sql. Upgrade: a MigrationSource provider if a second real source ever appears.
// The unknown-version guard only runs when `sources` is left at its default — a test that overrides it
// with a synthetic migration is deliberately not exercising "the database has real files this code
// doesn't ship", so it's exempt by construction rather than something the guard has to reason about.
export function applyMigrations(db: DatabaseSync, sources?: MigrationSource[]): void {
  const usingDefaultSources = sources === undefined;
  const effectiveSources = sources ?? readMigrationSources(migrationsDir);

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version));

  if (usingDefaultSources) rejectUnknownAppliedVersions(applied, effectiveSources);

  for (const { version, sql } of effectiveSources) {
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
      if (hasChecksumColumn(db)) {
        db.prepare('INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)').run(version, new Date().toISOString(), sha256Hex(sql));
      } else {
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      }
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

  reconcileChecksums(db, effectiveSources);
}
