const MINUTE_MS = 60_000;

/** Whole minutes a prompt has waited, never less than 1: the item exists only once the wait passed a threshold of at least one minute. */
export function minutesWaiting(waitingSince: string, nowMs: number): number {
  const waitedMs = nowMs - Date.parse(waitingSince);
  return Math.max(1, Math.floor(waitedMs / MINUTE_MS));
}

/** The ISSUE sentence of a session stuck on a permission prompt; it names no tool or path, whose words may carry a secret. */
export function silentBlockCopyOf({ minutes, sessionName }: { minutes: number; sessionName: string }): string {
  return `Waiting on a permission prompt for ${minutes} min — ${sessionName} can't continue until you decide.`;
}

/** The sentence of Copy details: the session name is left out, the session is named by the card. */
export function silentBlockDetailsMessageOf(minutes: number): string {
  return `Waiting on a permission prompt for ${minutes} min.`;
}
