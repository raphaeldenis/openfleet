export const ERROR_KINDS = ['invalid_request', 'unauthorized', 'not_found', 'conflict', 'too_large', 'unavailable', 'internal'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** How the caller recovers. never: fix the input. after_refresh: reload what moved, then decide. later: same call again. */
export type ErrorRetry = 'never' | 'after_refresh' | 'later';
const ERROR_RETRIES: readonly ErrorRetry[] = ['never', 'after_refresh', 'later'];

export const HTTP_STATUS_BY_KIND: Record<ErrorKind, number> = {
  invalid_request: 400, unauthorized: 401, not_found: 404, conflict: 409, too_large: 413, unavailable: 503, internal: 500,
};
export const RETRY_BY_KIND: Record<ErrorKind, ErrorRetry> = {
  invalid_request: 'never', unauthorized: 'never', not_found: 'never', conflict: 'after_refresh', too_large: 'never', unavailable: 'later', internal: 'later',
};

interface ErrorCodeSpec { kind: ErrorKind; retry?: ErrorRetry }

/** Every code on the wire, each in exactly one kind. The kind decides the http status and the default retry; the code decides the copy. */
export const ERROR_CODES = {
  invalid_body: { kind: 'invalid_request' },
  invalid_json: { kind: 'invalid_request' },
  invalid_url: { kind: 'invalid_request' },
  unknown_harness: { kind: 'invalid_request' },
  message_too_long: { kind: 'invalid_request' },
  query_too_long: { kind: 'invalid_request' },

  unauthorized: { kind: 'unauthorized' },

  not_found: { kind: 'not_found' },
  project_not_found: { kind: 'not_found' },
  no_state: { kind: 'not_found' },
  session_not_found: { kind: 'not_found' },
  note_not_found: { kind: 'not_found' },
  store_not_found: { kind: 'not_found' },
  view_not_found: { kind: 'not_found' },
  row_not_found: { kind: 'not_found' },
  manager_not_found: { kind: 'not_found' },

  // A conflict retries `never` unless a reload (stale_revision) or waiting (file_unreadable, too_many_pending, children_cap) can change the answer.
  session_closed: { kind: 'conflict', retry: 'never' },
  stale_revision: { kind: 'conflict', retry: 'after_refresh' },
  file_backed: { kind: 'conflict', retry: 'never' },
  file_unreadable: { kind: 'conflict', retry: 'later' },
  path_escapes_docs_folder: { kind: 'conflict', retry: 'never' },
  duplicate_name: { kind: 'conflict', retry: 'never' },
  // Decision D10 moves this to invalid_request (400); it stays a conflict (409) until that lands.
  constraint_violation: { kind: 'conflict', retry: 'never' },
  not_closed: { kind: 'conflict', retry: 'never' },
  directory_missing: { kind: 'conflict', retry: 'never' },
  directory_changed: { kind: 'conflict', retry: 'never' },
  directory_unreadable: { kind: 'conflict', retry: 'never' },
  already_resolved: { kind: 'conflict', retry: 'never' },
  config_unreadable: { kind: 'conflict', retry: 'never' },
  config_read_only: { kind: 'conflict', retry: 'never' },
  message_id_reused: { kind: 'conflict', retry: 'never' },
  too_many_pending: { kind: 'conflict', retry: 'later' },
  children_cap: { kind: 'conflict', retry: 'later' },
  outside_lineage: { kind: 'conflict', retry: 'never' },
  not_a_manager: { kind: 'conflict', retry: 'never' },
  directory_in_use: { kind: 'conflict', retry: 'never' },
  store_has_rows: { kind: 'conflict', retry: 'never' },
  duplicate_id: { kind: 'conflict', retry: 'never' },
  no_docs_folder: { kind: 'conflict', retry: 'never' },
  not_file_backed: { kind: 'conflict', retry: 'never' },

  payload_too_large: { kind: 'too_large' },
  note_too_large: { kind: 'too_large' },
  row_cap: { kind: 'too_large' },
  state_too_large: { kind: 'too_large' },

  daemon_shutting_down: { kind: 'unavailable' },
  daemon_degraded: { kind: 'unavailable' },

  internal_error: { kind: 'internal' },
  launch_failed: { kind: 'internal' },
  resume_timeout: { kind: 'internal' },
  db_stuck: { kind: 'internal' },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const retryOf = (code: ErrorCode): ErrorRetry => {
  const { retry } = ERROR_CODES[code] as ErrorCodeSpec;
  return retry ?? RETRY_BY_KIND[ERROR_CODES[code].kind];
};

/** For the layers that already know the code (route guards, MCP tools, the daemon's own checks); domain modules keep their own classes. */
export class OpenFleetError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly options: { hint?: string; detail?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
  }

  get kind(): ErrorKind {
    return ERROR_CODES[this.code].kind;
  }
}

export interface ErrorEnvelope {
  error: ErrorCode;
  kind: ErrorKind;
  retry: ErrorRetry;
  /** One sentence, caller-safe, present tense, no path, no SQL. */
  message: string;
  /** What to do, imperative. */
  hint?: string;
  detail?: unknown;
  /** 8 hex chars, only when kind is internal: the same id is in the log. */
  id?: string;
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.includes(value as T);

/** Light shape check for a parsed response body; an unknown code from a newer daemon still passes. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const { error, kind, retry, message } = value as Record<string, unknown>;
  return typeof error === 'string' && typeof message === 'string' && isOneOf(ERROR_KINDS, kind) && isOneOf(ERROR_RETRIES, retry);
}
