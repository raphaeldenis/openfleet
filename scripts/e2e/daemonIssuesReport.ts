import type { DaemonIssue } from '../../packages/shared/src/daemonIssues.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const CREDENTIAL_PATTERN = /bearer\s+\S+|authorization\S*/gi;

/** Returns a fixed-shape line naming only the kind of the error, never its message (a Playwright request error lists every request header, the admin token included). */
export function describeUnreadableDaemonIssues(error: unknown): string {
  const errorName = error instanceof Error ? error.name : 'unknown error';
  const safeErrorName = errorName.replace(CREDENTIAL_PATTERN, '[redacted]');
  return `daemon issues unavailable: ${safeErrorName}`;
}

/** Returns one line per active daemon issue of a GET /api/diagnostics document, or null when the daemon reports none. */
export function describeDaemonIssues(diagnostics: unknown): string | null {
  const health = isRecord(diagnostics) ? diagnostics.health : undefined;
  const issues = isRecord(health) && Array.isArray(health.issues) ? (health.issues as DaemonIssue[]) : [];
  if (issues.length === 0) return null;
  return issues.map(({ code, count, since, id, message }) => `${code} ×${count} since ${since} [${id}]: ${message}`).join('\n');
}
