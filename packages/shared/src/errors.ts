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
  invalid_branch_name: { kind: 'invalid_request' },
  invalid_mode: { kind: 'invalid_request' },
  unknown_harness: { kind: 'invalid_request' },
  // A bad cell value is the caller's row (decision D10): it answers 400, not 409.
  constraint_violation: { kind: 'invalid_request' },
  // A manager log row carries a kind outside the closed list MANAGER_LOG_KINDS: another kind from the list makes the same write succeed.
  log_kind_not_allowed: { kind: 'invalid_request' },
  // An agent that is not a manager inserted a row into the backlog of a project whose repository is shared with a team: the finding goes to the manager.
  backlog_write_refused: { kind: 'invalid_request' },
  message_too_long: { kind: 'invalid_request' },
  query_too_long: { kind: 'invalid_request' },
  outside_own_repository: { kind: 'invalid_request' },
  docs_root_invalid: { kind: 'invalid_request' },
  docs_root_forbidden: { kind: 'invalid_request' },

  // A condition list of a trigger holds at most 32 conditions; a path outside the event namespaces of the WHEN source is refused naming the right prefix.
  too_many_conditions: { kind: 'invalid_request' },
  trigger_field_prefix: { kind: 'invalid_request' },

  // A playbook is refused at save: a cell kind that is reserved or unsupported, a graph that does not hold together, a size over a cap, or a template in a place that may not hold it.
  cell_kind_reserved: { kind: 'invalid_request' },
  cell_kind_unsupported: { kind: 'invalid_request' },
  playbook_graph_invalid: { kind: 'invalid_request' },
  playbook_limit_exceeded: { kind: 'invalid_request' },
  secret_not_allowed_here: { kind: 'invalid_request' },
  untrusted_reference: { kind: 'invalid_request' },
  non_canonical_url: { kind: 'invalid_request' },
  unknown_token: { kind: 'invalid_request' },
  invalid_secret_name: { kind: 'invalid_request' },

  unauthorized: { kind: 'unauthorized' },
  // Arming a trigger is a gesture of a human: the admin token alone is not the proof, a single-use proof minted by the desktop app is.
  human_proof_required: { kind: 'unauthorized' },

  not_found: { kind: 'not_found' },
  project_not_found: { kind: 'not_found' },
  no_state: { kind: 'not_found' },
  session_not_found: { kind: 'not_found' },
  note_not_found: { kind: 'not_found' },
  store_not_found: { kind: 'not_found' },
  view_not_found: { kind: 'not_found' },
  row_not_found: { kind: 'not_found' },
  manager_not_found: { kind: 'not_found' },
  handoff_not_found: { kind: 'not_found' },
  // The id of another manager's proposal reads exactly like an id nobody proposed.
  proposal_not_found: { kind: 'not_found' },
  law_not_found: { kind: 'not_found' },
  // A trigger of another project reads exactly like one that does not exist.
  trigger_not_found: { kind: 'not_found' },
  trigger_condition_not_found: { kind: 'not_found' },
  // A playbook of another project reads exactly like one that does not exist.
  playbook_not_found: { kind: 'not_found' },
  playbook_cell_not_found: { kind: 'not_found' },
  // The revision was never kept, or was dropped when the playbook went over its ten versions.
  playbook_version_not_found: { kind: 'not_found' },
  playbook_run_not_found: { kind: 'not_found' },

  // A run is refused: no human approved this content (or an edit cleared the approval), the digest a human confirmed is not the digest of the playbook as it stands,
  // a script file is not the one that was approved, a script is not under a script root, a cell kind this runner does not execute, a run already in progress.
  playbook_unapproved: { kind: 'conflict', retry: 'never' },
  approval_digest_mismatch: { kind: 'conflict', retry: 'after_refresh' },
  script_changed: { kind: 'conflict', retry: 'never' },
  script_not_allowed: { kind: 'conflict', retry: 'never' },
  playbook_not_runnable: { kind: 'conflict', retry: 'never' },
  playbook_run_busy: { kind: 'conflict', retry: 'later' },

  // The playbook moved since it was read: reloading it shows the current revision. A locked playbook takes writes from the desktop app only.
  playbook_conflict: { kind: 'conflict', retry: 'after_refresh' },
  playbook_locked: { kind: 'conflict', retry: 'never' },

  // The fire breaker disarmed a trigger that fired more than 30 times in a minute: only a human arms it again.
  breaker_open: { kind: 'conflict', retry: 'never' },

  // A conflict retries `never` unless a reload (stale_revision) or waiting (file_unreadable, too_many_pending, children_cap) can change the answer.
  session_closed: { kind: 'conflict', retry: 'never' },
  stale_revision: { kind: 'conflict', retry: 'after_refresh' },
  file_backed: { kind: 'conflict', retry: 'never' },
  file_unreadable: { kind: 'conflict', retry: 'later' },
  path_escapes_docs_folder: { kind: 'conflict', retry: 'never' },
  duplicate_name: { kind: 'conflict', retry: 'never' },
  worktree_exists: { kind: 'conflict', retry: 'never' },
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
  // A human answering, or the manager withdrawing a proposal of its own, frees a place: the same call then succeeds.
  governance_queue_full: { kind: 'conflict', retry: 'later' },
  // The law moved since the human opened it: reloading it shows the current text and revision.
  law_revision_conflict: { kind: 'conflict', retry: 'after_refresh' },
  // A withdrawn law is history: it is neither edited nor withdrawn again.
  law_withdrawn: { kind: 'conflict', retry: 'never' },
  // A new item of questions_for_human that no escalation of the daemon produced: submitting the question with its class goes through the ladder.
  question_unclassified: { kind: 'invalid_request' },
  // The ticket has an escalation a human has not answered yet: the same call succeeds once the human answers.
  escalation_open: { kind: 'conflict', retry: 'later' },
  // The note of the plan moved after the opinion of the arbiter: a new opinion on the current revision is what lets the same call succeed.
  criteria_stale: { kind: 'conflict', retry: 'never' },
  escalation_not_found: { kind: 'not_found' },
  outside_lineage: { kind: 'conflict', retry: 'never' },
  not_a_manager: { kind: 'conflict', retry: 'never' },
  // Resuming the manager is what lets a pulse through again.
  manager_paused: { kind: 'conflict', retry: 'never' },
  // Editing the mission on the manager's profile fixes either one: the same reopen then succeeds.
  mission_missing: { kind: 'conflict', retry: 'never' },
  mission_too_large: { kind: 'conflict', retry: 'never' },
  // Reading the manager base (base_not_read), reading the mission note in full (note_not_read), recording the missing findings (findings_required) or reviewing the new head (verdict_stale) is what lets the same call succeed.
  base_not_read: { kind: 'conflict', retry: 'never' },
  note_not_read: { kind: 'conflict', retry: 'never' },
  findings_required: { kind: 'conflict', retry: 'never' },
  verdict_stale: { kind: 'conflict', retry: 'never' },
  directory_in_use: { kind: 'conflict', retry: 'never' },
  duplicate_child: { kind: 'conflict', retry: 'never' },
  // The directory belongs to no project: spawning inside a project's folders or worktrees is what lets the same call succeed.
  directory_not_in_project: { kind: 'conflict', retry: 'never' },
  no_parent: { kind: 'conflict', retry: 'never' },
  // The directory moved while the spawn was being checked: the same call can succeed once it settles.
  spawn_raced: { kind: 'conflict', retry: 'later' },
  store_has_rows: { kind: 'conflict', retry: 'never' },
  duplicate_id: { kind: 'conflict', retry: 'never' },
  no_docs_folder: { kind: 'conflict', retry: 'never' },
  not_file_backed: { kind: 'conflict', retry: 'never' },
  // The permissions can be fixed while the app stays open: the same save succeeds afterwards.
  docs_folder_not_writable: { kind: 'conflict', retry: 'later' },
  // Another project already holds that folder (same directory once links and letter case are resolved): only another folder passes.
  docs_folder_already_used: { kind: 'conflict', retry: 'never' },
  docs_root_not_writable: { kind: 'conflict', retry: 'later' },

  payload_too_large: { kind: 'too_large' },
  note_too_large: { kind: 'too_large' },
  row_cap: { kind: 'too_large' },
  state_too_large: { kind: 'too_large' },

  // The project keeps a row journal append-only and a done row linked to a pull request: only a changed write (previous journal plus a line, or a pr_url) passes.
  row_guard_violation: { kind: 'invalid_request' },

  daemon_shutting_down: { kind: 'unavailable' },
  daemon_degraded: { kind: 'unavailable' },
  // The daemon keeps retrying a queued message on its own; the caller only waits.
  delivery_failed: { kind: 'unavailable', retry: 'later' },
  // The same message fails again: only a changed body (without invisible characters) can be delivered.
  message_held_for_review: { kind: 'invalid_request', retry: 'never' },
  // The process is gone: the same call cannot help, only reopening the session can. Not internal, so its actionable message reaches the client.
  harness_exited: { kind: 'unavailable', retry: 'never' },
  // A missing binary on the daemon PATH: only installing it, or starting the daemon from a shell that has it, helps.
  claude_not_found: { kind: 'unavailable', retry: 'never' },
  git_unavailable: { kind: 'unavailable', retry: 'never' },
  // The GitHub CLI is missing from the daemon PATH, or not logged in: only installing it or running `gh auth login` helps.
  gh_unavailable: { kind: 'unavailable', retry: 'never' },
  gh_not_authenticated: { kind: 'unavailable', retry: 'never' },
  // GitHub or the network may answer correctly on the next poll.
  gh_bad_output: { kind: 'unavailable', retry: 'later' },
  gh_timeout: { kind: 'unavailable', retry: 'later' },
  // Unwatching a pull request frees a place, or the manager waits for one to merge.
  too_many_watched_prs: { kind: 'conflict', retry: 'later' },
  // The binary answers `--version` with a failure: repairing or reinstalling it, then waiting out the 60 s health cache, lets the same spawn succeed.
  harness_binary_broken: { kind: 'unavailable', retry: 'later' },
  // No playbook, connection or trigger declares a secret under this scope, or the scope declares no secret of this name.
  secret_scope_not_found: { kind: 'not_found' },
  secret_not_declared: { kind: 'not_found' },
  // The name is declared but no value sits in this device's keychain: only a human connecting it on this device helps.
  secret_not_connected_on_this_device: { kind: 'unavailable', retry: 'never' },
  // The desktop app that holds the keychain is closed, the keychain is locked or the exchange timed out: starting the app or unlocking the keychain helps.
  secret_store_unavailable: { kind: 'unavailable', retry: 'later' },
  // A value under 8 characters cannot be masked in an output without destroying it.
  secret_too_short: { kind: 'invalid_request' },
  // The single-use operator nonce is missing, spent, expired or unknown: mint a fresh one from the desktop app.
  secret_nonce_invalid: { kind: 'unauthorized' },

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
