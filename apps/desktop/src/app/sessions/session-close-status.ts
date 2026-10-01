import type { SessionCloseReason } from '@openfleet/shared';

export type SessionCloseStatus =
  | { kind: 'clean'; exitCode: number }
  | { kind: 'failed'; exitCode: number }
  | { kind: 'unknown' };

// The claude CLI dies by SIGTERM (128 + 15) when the user, a parent or a daemon shutdown closes it.
const SIGTERM_EXIT_CODE = 143;
const NEUTRAL_EXIT_CODES: readonly number[] = [0, SIGTERM_EXIT_CODE];

export function closeStatusFor(exitCode: number | undefined): SessionCloseStatus {
  if (exitCode === undefined) return { kind: 'unknown' };
  const isNeutralExit = NEUTRAL_EXIT_CODES.includes(exitCode);
  return isNeutralExit ? { kind: 'clean', exitCode } : { kind: 'failed', exitCode };
}

export interface ClosedStripCopy {
  variant: 'error' | 'neutral';
  title: string;
  description: string;
}

export function closedStripCopyFor(exitCode: number | undefined, reason?: SessionCloseReason): ClosedStripCopy {
  const status = closeStatusFor(exitCode);
  const isHarnessCrash = reason === 'harness_exit';
  if (isHarnessCrash) {
    const exitTitle = exitCode === undefined ? '■ Session closed' : `■ Closed · exit ${exitCode}`;
    return { variant: 'error', title: exitTitle, description: 'The agent process ended unexpectedly · worktree kept · transcript is read-only.' };
  }
  if (status.kind === 'unknown') {
    return { variant: 'neutral', title: '■ Session closed', description: 'Session closed · worktree kept · transcript is read-only.' };
  }
  if (status.kind === 'clean') {
    return { variant: 'neutral', title: `■ Closed · exit ${status.exitCode}`, description: 'Closed · worktree kept · transcript is read-only.' };
  }
  return {
    variant: 'error',
    title: `■ Closed · exit ${status.exitCode}`,
    description: 'The session exited with an error · worktree kept · transcript is read-only.',
  };
}

export function exitCodeLabel(exitCode: number | undefined): string {
  const status = closeStatusFor(exitCode);
  return status.kind === 'unknown' ? 'closed' : `closed · exit ${status.exitCode}`;
}

const RESUME_FAILURE_COPY_BY_REASON: Partial<Record<SessionCloseReason, string>> = {
  resume_timeout: 'The harness did not come up in time — the resume timed out.',
  launch_failed: 'The harness failed to launch on resume.',
};

/** Why a resume never came up, for the close reasons that mean it; undefined for any other close. */
export function resumeFailureCopyFor(reason: SessionCloseReason | undefined): string | undefined {
  return reason === undefined ? undefined : RESUME_FAILURE_COPY_BY_REASON[reason];
}

