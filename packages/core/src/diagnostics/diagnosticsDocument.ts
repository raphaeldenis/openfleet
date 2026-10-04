import { closeReasonOfExitCode, type DiagnosticsDocument, type DiagnosticsMigration, type DiagnosticsSession, type Session } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { recentLogLines, redactedText } from '../logger.js';
import type { DegradedRegistry } from '../process/degradedRegistry.js';
import { isSecretEntry, MASK } from '../redact.js';
import { DAEMON_VERSION } from '../version.js';

const OPENFLEET_HOME_ALIAS = '$OPENFLEET_HOME';

export interface DiagnosticsSources {
  db: DatabaseSync;
  degraded: DegradedRegistry;
  listSessions: () => Session[];
  port: number;
  e2eEnabled: boolean;
}

interface RedactionOptions { keepNewlines: boolean }

/** Runs the logger's redaction on every string of a JSON-like value, keys included; a value under a secret-named key is masked whole. */
function redactedDeep(value: unknown, options: RedactionOptions): unknown {
  if (typeof value === 'string') return redactedText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactedDeep(item, options));
  if (typeof value !== 'object' || value === null) return value;
  const redactedEntries = Object.entries(value).map(([key, entry]) => {
    const redactedKey = redactedText(key, options);
    return [redactedKey, isSecretEntry(redactedKey, entry) ? MASK : redactedDeep(entry, options)] as const;
  });
  return Object.fromEntries(redactedEntries);
}

const parsedOrText = (line: string): unknown => {
  try { return JSON.parse(line); } catch { return line; }
};

const orWhenItThrows = <T>(read: () => T, fallback: T): T => {
  try { return read(); } catch { return fallback; }
};

const messageOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message === '' ? 'the check failed' : message;
};

function quickCheckOf(db: DatabaseSync): string {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    const isHealthy = rows.length === 1 && rows[0]!.quick_check === 'ok';
    return isHealthy ? 'ok' : rows.map((row) => row.quick_check).join('; ');
  } catch (error) {
    return messageOf(error);
  }
}

function databaseSizeBytes(db: DatabaseSync): number {
  const { page_count: pageCount } = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  return pageCount * pageSize;
}

function appliedMigrations(db: DatabaseSync): DiagnosticsMigration[] {
  const rows = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all() as { version: string; applied_at: string }[];
  return rows.map(({ version, applied_at: appliedAt }) => ({ id: version, appliedAt }));
}

function describedSession(session: Session): DiagnosticsSession {
  const { id, name, state, harness, model, parentId, exitCode, closedAt, directory } = session;
  const reason = closeReasonOfExitCode(exitCode);
  return { id, name, state, harness, ...(model && { model }), ...(parentId && { parentId }), ...(exitCode !== undefined && { exitCode }), ...(reason && { reason }), ...(closedAt && { closedAt }), directory };
}

/** Builds the diagnostics document. A section whose source throws (a stuck database) is reported empty or by its error text, never by a failed answer. */
export function buildDiagnosticsDocument(sources: DiagnosticsSources): DiagnosticsDocument {
  const { db, degraded, listSessions, port, e2eEnabled } = sources;
  const document: DiagnosticsDocument = {
    generatedAt: new Date().toISOString(),
    version: { openfleet: DAEMON_VERSION, node: process.version, platform: process.platform },
    config: { port, home: OPENFLEET_HOME_ALIAS, e2eEnabled },
    health: { status: degraded.status(), issues: degraded.list() },
    migrations: orWhenItThrows(() => appliedMigrations(db), []),
    db: { quickCheck: quickCheckOf(db), sizeBytes: orWhenItThrows(() => databaseSizeBytes(db), 0) },
    sessions: orWhenItThrows(() => listSessions().map(describedSession), []),
    log: recentLogLines().map(parsedOrText),
  };
  const { log: logRecords, ...rest } = document;
  const redactedRest = redactedDeep(rest, { keepNewlines: false }) as Omit<DiagnosticsDocument, 'log'>;
  const redactedLog = redactedDeep(logRecords, { keepNewlines: true }) as unknown[];
  return { ...redactedRest, log: redactedLog };
}
