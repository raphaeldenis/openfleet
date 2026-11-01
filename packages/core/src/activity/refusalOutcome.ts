import { OpenFleetError } from '@openfleet/shared';

// A rule refused the caller (role, lineage, project boundary, governance gate); every other error code is a failure, a missing thing or a bad input.
const DENIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'unauthorized', 'outside_lineage', 'not_a_manager', 'backlog_write_refused', 'outside_own_repository', 'directory_not_in_project',
  'base_not_read', 'note_not_read', 'findings_required', 'verdict_stale', 'criteria_stale', 'escalation_open', 'question_unclassified',
  'manager_paused', 'row_guard_violation', 'message_held_for_review',
]);

/** The outcome of a call that failed with this error code: denied when a rule refused the caller, error otherwise. */
export const outcomeOfErrorCode = (errorCode: string | undefined): 'denied' | 'error' =>
  errorCode !== undefined && DENIAL_ERROR_CODES.has(errorCode) ? 'denied' : 'error';

export const UNKNOWN_FAILURE = 'unknown';

/** The detail a failure leaves in the log: its error code, or the name of its class, never its message. */
export const failureDetailOf = (error: unknown): string => {
  if (error instanceof OpenFleetError) return error.code;
  return error instanceof Error ? error.name : UNKNOWN_FAILURE;
};
