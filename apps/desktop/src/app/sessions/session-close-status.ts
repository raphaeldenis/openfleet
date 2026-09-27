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
