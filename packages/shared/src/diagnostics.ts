import type { DaemonIssue } from './daemonIssues.js';
import type { HarnessId, SessionState } from './session.js';
import type { SessionCloseReason } from './events.js';

export const DIAGNOSTICS_PATH = '/api/diagnostics';

/** A session as the diagnostics document describes it: no transcript, no message body, the directory already shortened. */
export interface DiagnosticsSession {
  id: string;
  name: string;
  state: SessionState;
  harness: HarnessId;
  model?: string;
  parentId?: string;
  exitCode?: number;
  reason?: SessionCloseReason;
  closedAt?: string;
  directory: string;
}

export interface DiagnosticsMigration { id: string; appliedAt: string }

/** The document `GET /api/diagnostics` answers. Every string in it went through the daemon's redaction. */
export interface DiagnosticsDocument {
  generatedAt: string;
  version: { openfleet: string; node: string; platform: string };
  config: { port: number; home: string; e2eEnabled: boolean };
  health: { status: 'ok' | 'degraded'; issues: DaemonIssue[] };
  migrations: DiagnosticsMigration[];
  /** `ok`, or the redacted text of the error the check raised. */
  db: { quickCheck: string; sizeBytes: number };
  sessions: DiagnosticsSession[];
  /** The log ring buffer, one parsed record per line (a line that is not JSON stays a string). */
  log: unknown[];
}
