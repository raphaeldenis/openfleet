import type { SessionCloseReason } from '@openfleet/shared';
import { closeStatusFor } from './session-close-status';

export interface LifecycleStrip {
  variant: 'error' | 'attention';
  icon: string;
  title: string;
  message: string;
  /** True when the strip is the daemon's answer to a resume, so it is announced even on a session opened already failed. */
  isResumeFailure: boolean;
}

export interface ClosedSessionPresentation {
  /** The one place the situation is explained; absent when a closed session has nothing to act on or explain. */
  strip?: LifecycleStrip;
  cardTitle: string;
  /** Only when no strip explains the close, so the same sentence is never shown twice. */
  cardBody?: string;
  cardTone: 'neutral' | 'error';
}

export interface ClosedSessionFacts {
  exitCode?: number | undefined;
  reason?: SessionCloseReason | undefined;
  /** The readable error of a reopen request the daemon refused. */
  resumeRequestError?: string | undefined;
}

const NOT_RUNNING_CARD_TITLE = 'Not running';
const CLOSED_CARD_TITLE = 'Closed';
const WORKTREE_KEPT_CARD_BODY = 'Worktree kept · transcript is read-only.';

const RESUME_REQUEST_FAILED_TITLE = 'Resume failed';
const RESUME_TIMED_OUT_STRIP = {
  variant: 'error', icon: '■', title: 'Resume timed out', message: 'The session did not come back in time — try again.', isResumeFailure: true,
} satisfies LifecycleStrip;
const LAUNCH_FAILED_STRIP = {
  variant: 'error', icon: '✕', title: 'Agent could not start',
  message: 'The agent could not start — check that the claude CLI is installed and on the PATH the daemon runs with.', isResumeFailure: true,
} satisfies LifecycleStrip;
const DAEMON_STOPPED_STRIP = {
  variant: 'attention', icon: '■', title: 'Daemon stopped', message: 'The daemon stopped — the session resumes when it starts again.', isResumeFailure: false,
} satisfies LifecycleStrip;
const AGENT_EXITED_STRIP = {
  variant: 'error', icon: '■', title: 'Agent process exited',
  message: 'The agent process ended unexpectedly — reopen the session to resume the conversation.', isResumeFailure: false,
} satisfies LifecycleStrip;

/** Maps what is known about a closed session to the strip that explains it and the card that offers the actions. */
export function closedSessionPresentationFor({ exitCode, reason, resumeRequestError }: ClosedSessionFacts): ClosedSessionPresentation {
  if (resumeRequestError !== undefined) {
    const strip: LifecycleStrip = { variant: 'error', icon: '✕', title: RESUME_REQUEST_FAILED_TITLE, message: resumeRequestError, isResumeFailure: true };
    return { strip, cardTitle: NOT_RUNNING_CARD_TITLE, cardTone: 'error' };
  }
  if (reason === 'resume_timeout') return { strip: RESUME_TIMED_OUT_STRIP, cardTitle: NOT_RUNNING_CARD_TITLE, cardTone: 'error' };
  if (reason === 'launch_failed') return { strip: LAUNCH_FAILED_STRIP, cardTitle: NOT_RUNNING_CARD_TITLE, cardTone: 'error' };
  if (reason === 'daemon_shutdown') return { strip: DAEMON_STOPPED_STRIP, cardTitle: CLOSED_CARD_TITLE, cardTone: 'neutral' };

  const status = closeStatusFor(exitCode);
  const cardTitle = status.kind === 'unknown' ? CLOSED_CARD_TITLE : `${CLOSED_CARD_TITLE} · exit ${status.exitCode}`;
  const isHarnessExit = reason === 'harness_exit' || status.kind === 'failed';
  if (isHarnessExit) return { strip: AGENT_EXITED_STRIP, cardTitle, cardTone: 'error' };
  return { cardTitle, cardBody: WORKTREE_KEPT_CARD_BODY, cardTone: 'neutral' };
}
