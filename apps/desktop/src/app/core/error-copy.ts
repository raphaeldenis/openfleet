import { ERROR_CODES, HTTP_STATUS_BY_KIND, retryOf, type DaemonIssue, type DegradedCode, type ErrorCode, type ErrorEnvelope, type ErrorRetry } from '@openfleet/shared';
import { ApiError } from './fleet-api.service';

/** What the user was doing when the error came back: it decides the advice ("shorten the mission" vs "shorten the name"). */
export type ErrorAction = 'generic' | 'send' | 'create_session' | 'create_manager' | 'resume' | 'load_todos';

export interface ErrorContext {
  action: ErrorAction;
}

export interface ErrorCopy {
  /** What happened, then what to do. An internal error ends with its ref. */
  text: string;
  /** The ref a human quotes, present for an internal error only. */
  ref?: string;
}

// Fixed copy of the actions that fail with no error worth telling apart.
export const CLOSE_ERROR = 'Could not close the session — try again.';
export const INTERRUPT_ERROR = 'Could not interrupt the session — try again.';
export const RENAME_ERROR = 'Could not rename — try again.';
export const SEND_ERROR = 'Could not send — your message is kept.';
export const GENERIC_DECISION_ERROR = 'Could not send decision — try again.';
export const GENERIC_REOPEN_ERROR = 'Could not resume the session — try again.';
export const DAEMON_UNREACHABLE = 'Can’t reach the OpenFleet daemon — check that it is running, then try again.';

/** `what` happened; `fix` is what the user does. The retry hint of the envelope decides the ending, so "try again" appears exactly when it can help. */
interface CodeCopy {
  what: string;
  fix?: string;
  /** A retry of an action the user just made needs no waiting: "try again" instead of "try again in a moment". */
  isRetryableAtOnce?: boolean;
}

const COPY_BY_CODE: Record<ErrorCode, CodeCopy> = {
  invalid_body: { what: 'The daemon rejected these values', fix: 'check them and change what is wrong' },
  invalid_json: { what: 'The app sent a request the daemon could not read', fix: 'restart the app' },
  invalid_url: { what: 'That address is not valid', fix: 'check it' },
  invalid_branch_name: { what: 'The branch name is not valid', fix: 'pick another one' },
  unknown_harness: { what: 'This kind of agent is not available', fix: 'pick another one' },
  constraint_violation: { what: 'A value breaks a rule of this table', fix: 'fix the value' },
  message_too_long: { what: 'The message is too long', fix: 'shorten it' },
  query_too_long: { what: 'The query is too long', fix: 'shorten it' },
  outside_own_repository: { what: 'That path is outside the session’s repository', fix: 'pick one inside it' },

  unauthorized: { what: 'The daemon refused the app’s credentials', fix: 'check the admin token' },

  not_found: { what: 'That item no longer exists' },
  project_not_found: { what: 'That project no longer exists' },
  no_state: { what: 'This session has not reported a working state yet' },
  session_not_found: { what: 'That session no longer exists' },
  note_not_found: { what: 'That note no longer exists' },
  store_not_found: { what: 'That table no longer exists' },
  view_not_found: { what: 'That view no longer exists' },
  row_not_found: { what: 'That row no longer exists' },
  manager_not_found: { what: 'That manager no longer exists' },

  session_closed: { what: 'The session is closed', fix: 'resume it first' },
  stale_revision: { what: 'This note changed since you opened it' },
  file_backed: { what: 'This note lives in a file', fix: 'edit the file instead' },
  file_unreadable: { what: 'The daemon cannot read the note file right now' },
  path_escapes_docs_folder: { what: 'That path leaves the docs folder', fix: 'pick one inside it' },
  duplicate_name: { what: 'That name is already taken', fix: 'pick another one' },
  worktree_exists: { what: 'A folder for this branch already exists', fix: 'pick another branch name' },
  not_closed: { what: 'This session is not closed', fix: 'there is nothing to resume' },
  directory_missing: { what: 'The session’s directory no longer exists', fix: 'there is nothing to resume into' },
  directory_changed: { what: 'The session’s directory changed since it closed', fix: 'resume is refused for safety' },
  directory_unreadable: { what: 'The session’s directory cannot be read', fix: 'check its permissions' },
  already_resolved: { what: 'This was already decided elsewhere' },
  config_unreadable: { what: 'The daemon cannot read its configuration', fix: 'check the file permissions' },
  config_read_only: { what: 'The configuration is read-only', fix: 'make the file writable' },
  message_id_reused: { what: 'That message id was already used with another text' },
  too_many_pending: { what: 'Too many messages are waiting for this session' },
  children_cap: { what: 'This manager already runs as many sessions as allowed' },
  outside_lineage: { what: 'That session is outside this manager’s team' },
  not_a_manager: { what: 'This session is not a manager' },
  directory_in_use: { what: 'Another session already uses this directory', fix: 'pick another directory' },
  duplicate_child: { what: 'A session with that name already exists here', fix: 'pick another name' },
  no_parent: { what: 'This session has no parent' },
  spawn_raced: { what: 'The directory changed while the session was being created' },
  store_has_rows: { what: 'This table still has rows', fix: 'empty it first' },
  duplicate_id: { what: 'That id already exists' },
  no_docs_folder: { what: 'No docs folder is set', fix: 'set one first' },
  not_file_backed: { what: 'This note does not live in a file' },

  payload_too_large: { what: 'The request is too large', fix: 'shorten it' },
  note_too_large: { what: 'This note is too large', fix: 'shorten it' },
  row_cap: { what: 'This table reached its row limit', fix: 'delete some rows first' },
  state_too_large: { what: 'The working state is too large', fix: 'shorten it' },

  daemon_shutting_down: { what: 'The daemon is shutting down' },
  daemon_degraded: { what: 'The daemon is running degraded', fix: 'restart it when convenient' },
  delivery_failed: { what: 'The message is not delivered yet and stays queued' },
  message_held_for_review: { what: 'The message was not sent: the CLI held it because it contains invisible characters', fix: 'resend it without them' },
  harness_exited: { what: 'The agent process ended', fix: 'resume the session' },
  claude_not_found: { what: 'The claude command is not on the daemon’s PATH', fix: 'install it, or start the daemon from a shell that has it' },
  git_unavailable: { what: 'Git is not available to the daemon', fix: 'install it' },

  internal_error: { what: 'The daemon hit an unexpected error' },
  launch_failed: { what: 'The agent failed to launch' },
  resume_timeout: { what: 'The agent did not come up in time' },
  db_stuck: { what: 'The daemon’s database is stuck', fix: 'restart the daemon' },
};

const WORDS_OF_RETRY: Record<ErrorRetry, (copy: CodeCopy) => string> = {
  never: ({ what, fix }) => (fix ? `${what} — ${fix}.` : `${what}.`),
  later: ({ what, fix, isRetryableAtOnce }) => {
    if (fix) return `${what} — ${fix}, then try again.`;
    return isRetryableAtOnce ? `${what} — try again.` : `${what} — try again in a moment.`;
  },
  after_refresh: ({ what }) => `${what} — reload, then try again.`,
};

const FALLBACK_BY_RETRY: Record<ErrorRetry, string> = {
  never: 'The daemon could not do that.',
  later: 'The daemon could not do that — try again in a moment.',
  after_refresh: 'Something changed — reload, then try again.',
};

const LOAD_TODOS_FAILED_BY_RETRY: Record<ErrorRetry, string> = {
  never: "Can't load the todos.",
  later: "Can't load the todos — try again.",
  after_refresh: "Can't load the todos — reload, then try again.",
};

const SHORTEN_BY_ACTION: Record<'create_session' | 'create_manager', string> = {
  create_session: 'shorten the directory or the name',
  create_manager: 'shorten the mission',
};

const BRANCH_NAME_RULES =
  'use up to 250 letters, digits, dots, dashes, underscores or slashes, start with a letter, digit or underscore, and avoid “..”, “//”, a trailing “.”, a part starting with “.” and the “.lock” ending';

type ActionCopy = Partial<Record<ErrorCode, CodeCopy>>;

function createCopy(kind: 'session' | 'manager'): ActionCopy {
  const action = kind === 'session' ? 'create_session' : 'create_manager';
  return {
    invalid_body: { what: 'The daemon rejected these values', fix: 'check the directory and the other fields' },
    invalid_branch_name: { what: 'The branch name is not valid', fix: BRANCH_NAME_RULES },
    worktree_exists: { what: 'A folder for this branch already exists', fix: 'pick another branch name' },
    payload_too_large: { what: 'The request is too large', fix: SHORTEN_BY_ACTION[action] },
    internal_error: { what: `The daemon hit an internal error while creating the ${kind}`, isRetryableAtOnce: true },
  };
}

const COPY_BY_ACTION: Record<ErrorAction, ActionCopy> = {
  generic: {},
  send: {},
  create_session: createCopy('session'),
  create_manager: createCopy('manager'),
  resume: {
    not_closed: { what: 'This session is not closed', fix: 'nothing to resume' },
    directory_missing: { what: "This session's directory no longer exists", fix: 'nothing to resume into' },
    directory_changed: { what: "This session's directory changed since it closed", fix: 'resume refused for safety' },
    directory_unreadable: { what: "This session's directory can't be read", fix: 'check its permissions' },
    launch_failed: { what: 'The harness failed to relaunch', isRetryableAtOnce: true },
  },
  load_todos: {},
};

const FALLBACK_BY_ACTION: Partial<Record<ErrorAction, string>> = {
  send: SEND_ERROR,
  create_session: 'Could not create the session — try again.',
  create_manager: 'Could not create the manager — try again.',
  resume: GENERIC_REOPEN_ERROR,
};

const NOT_CONNECTED_BY_ACTION: Partial<Record<ErrorAction, string>> = {
  send: SEND_ERROR,
  create_session: 'Could not create the session — check your connection, then try again.',
  create_manager: 'Could not create the manager — check your connection, then try again.',
  resume: GENERIC_REOPEN_ERROR,
};

const isKnownCode = (code: string | undefined): code is ErrorCode => code !== undefined && Object.hasOwn(ERROR_CODES, code);

const endsWithPeriod = (sentence: string) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);
const capitalized = (sentence: string) => sentence.charAt(0).toUpperCase() + sentence.slice(1);

/** A code this app has never heard of: the daemon's own caller-safe words, when it sent an envelope. */
function copyOfUnknownCode(envelope: ErrorEnvelope): string {
  const message = endsWithPeriod(capitalized(envelope.message));
  return envelope.hint ? `${message} ${endsWithPeriod(capitalized(envelope.hint))}` : message;
}

/** What the copy is built from: the same facts whether the failure came as a response or as a websocket envelope. */
interface Failure {
  code: string | undefined;
  status: number;
  envelope: ErrorEnvelope | undefined;
}

function retryOfFailure({ envelope, status }: Failure, code: ErrorCode | undefined): ErrorRetry {
  if (envelope) return envelope.retry;
  if (code) return retryOf(code);
  const isDaemonSideFailure = status === 0 || status >= 500;
  return isDaemonSideFailure ? 'later' : 'never';
}

function withRef(text: string, envelope: ErrorEnvelope | undefined): ErrorCopy {
  const ref = envelope?.kind === 'internal' ? envelope.id : undefined;
  return ref ? { text: `${text} (ref ${ref})`, ref } : { text };
}

function copyOfFailure(failure: Failure, { action }: ErrorContext): ErrorCopy {
  const { envelope } = failure;
  const code = isKnownCode(failure.code) ? failure.code : undefined;
  const retry = retryOfFailure(failure, code);
  if (code) return withRef(WORDS_OF_RETRY[retry](COPY_BY_ACTION[action][code] ?? COPY_BY_CODE[code]), envelope);
  if (envelope) return withRef(copyOfUnknownCode(envelope), envelope);
  if (action === 'load_todos') return { text: LOAD_TODOS_FAILED_BY_RETRY[retry] };
  return { text: FALLBACK_BY_ACTION[action] ?? FALLBACK_BY_RETRY[retry] };
}

/** Whether trying again can help: the same decision the sentence of `copyFor` ends on. */
export function retryOfError(error: unknown): ErrorRetry {
  if (!(error instanceof ApiError)) return 'later';
  const code = isKnownCode(error.code) ? error.code : undefined;
  return retryOfFailure({ code: error.code, status: error.status, envelope: error.envelope }, code);
}

/** The copy of an envelope that reached the app on the websocket instead of as a response. */
export function copyOfEnvelope(envelope: ErrorEnvelope, context: ErrorContext): ErrorCopy {
  return copyOfFailure({ code: envelope.error, status: HTTP_STATUS_BY_KIND[envelope.kind], envelope }, context);
}

const ADVICE_OF_STUCK_ISSUE = 'restart it when convenient';
const ADVICE_OF_SELF_CLEARING_ISSUE = 'it may clear by itself';

const ADVICE_BY_DEGRADED_CODE: Record<DegradedCode, string> = {
  uncaught_exception: ADVICE_OF_STUCK_ISSUE,
  db_stuck: ADVICE_OF_STUCK_ISSUE,
  hook_fail_open: ADVICE_OF_SELF_CLEARING_ISSUE,
  ws_broadcast_failed: ADVICE_OF_SELF_CLEARING_ISSUE,
  docs_folder_unreadable: ADVICE_OF_SELF_CLEARING_ISSUE,
};

const withoutTrailingPeriod = (sentence: string) => sentence.replace(/\.$/, '');

/** What a degraded-daemon issue says and what to do about it: restart only when it does not clear by itself. */
export function copyOfDaemonIssue({ code, message }: DaemonIssue): string {
  return `${withoutTrailingPeriod(message)} — ${ADVICE_BY_DEGRADED_CODE[code]}`;
}

/**
 * The sentence the user reads for a failed request: what happened, then what to do. Resolution order:
 * the entry of the action, the entry of the code, the daemon's own words for a code this app does not know, the fallback.
 * It never shows a raw message, a status number or a code.
 */
export function copyFor(error: unknown, context: ErrorContext): ErrorCopy {
  if (error instanceof ApiError) return copyOfFailure({ code: error.code, status: error.status, envelope: error.envelope }, context);
  return { text: NOT_CONNECTED_BY_ACTION[context.action] ?? DAEMON_UNREACHABLE };
}
