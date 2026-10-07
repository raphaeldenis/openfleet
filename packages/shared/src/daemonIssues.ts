/** The only things that put the daemon in the degraded state; a new source needs a line in the error-handling spec. */
export const DEGRADED_CODES = ['uncaught_exception', 'db_stuck', 'hook_fail_open', 'docs_folder_unreadable', 'ws_broadcast_failed', 'power_assertion_unavailable'] as const;
export type DegradedCode = (typeof DEGRADED_CODES)[number];

/** One active problem the daemon keeps running through. `id` is the ref a human quotes; it matches the log line written when the issue appeared. */
export interface DaemonIssue {
  code: DegradedCode;
  /** ISO time the issue first appeared; later occurrences raise `count` only. */
  since: string;
  /** Caller-safe, one sentence. */
  message: string;
  id: string;
  count: number;
}
