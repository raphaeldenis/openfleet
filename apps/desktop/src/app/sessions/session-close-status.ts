export type SessionCloseStatus =
  | { kind: 'clean' }
  | { kind: 'failed'; exitCode: number }
  | { kind: 'unknown' };

export function closeStatusFor(exitCode: number | undefined): SessionCloseStatus {
  if (exitCode === undefined) return { kind: 'unknown' };
  return exitCode === 0 ? { kind: 'clean' } : { kind: 'failed', exitCode };
}

export function exitCodeLabel(exitCode: number | undefined): string {
  const status = closeStatusFor(exitCode);
  return status.kind === 'failed' ? `closed · exit ${status.exitCode}` : status.kind === 'clean' ? 'closed · exit 0' : 'closed';
}

// The reopen route's 409/500 error codes (packages/core/src/sessions/sessionService.ts,
// SessionReopenError) mapped to copy a user can act on. `directory_unreadable` has no producing
// code path today but is kept here so a future backend addition renders sensibly with no UI change.
const REOPEN_ERROR_MESSAGES: Record<string, string> = {
  not_closed: 'This session is not closed — nothing to resume.',
  directory_missing: "This session's directory no longer exists — nothing to resume into.",
  directory_changed: "This session's directory changed since it closed — resume refused for safety.",
  directory_unreadable: "This session's directory can't be read — check its permissions.",
  launch_failed: 'The harness failed to relaunch — try again.',
};
export const GENERIC_REOPEN_ERROR = 'Could not resume the session — try again.';

// The exit codes the daemon stamps on a session whose resume never came up
// (packages/core/src/sessions/sessionService.ts: RESUME_TIMEOUT_EXIT_CODE, RESUME_LAUNCH_FAILED_EXIT_CODE).
const RESUME_FAILURE_REASONS: Record<number, string> = {
  [-1]: 'The harness did not come up in time — the resume timed out.',
  [-2]: 'The harness failed to launch on resume.',
};

export function resumeFailureReasonFor(exitCode: number | undefined): string | undefined {
  return exitCode === undefined ? undefined : RESUME_FAILURE_REASONS[exitCode];
}

export function reopenErrorMessage(code: string | undefined): string {
  return (code && REOPEN_ERROR_MESSAGES[code]) || GENERIC_REOPEN_ERROR;
}
