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

export function exitCodeLabel(exitCode: number | undefined): string {
  const status = closeStatusFor(exitCode);
  return status.kind === 'unknown' ? 'closed' : `closed · exit ${status.exitCode}`;
}
