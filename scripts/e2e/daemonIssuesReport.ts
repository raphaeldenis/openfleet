import type { DaemonIssue } from '../../packages/shared/src/daemonIssues.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Returns one line per active daemon issue of a GET /api/diagnostics document, or null when the daemon reports none. */
export function describeDaemonIssues(diagnostics: unknown): string | null {
  const health = isRecord(diagnostics) ? diagnostics.health : undefined;
  const issues = isRecord(health) && Array.isArray(health.issues) ? (health.issues as DaemonIssue[]) : [];
  if (issues.length === 0) return null;
  return issues.map(({ code, count, since, id, message }) => `${code} ×${count} since ${since} [${id}]: ${message}`).join('\n');
}
