export function countdownSecondsUntil(target: string, nowMs: number): number | null {
  const targetMs = new Date(target).getTime();
  if (!Number.isFinite(targetMs)) return null;
  return Math.max(0, Math.round((targetMs - nowMs) / 1000));
}

export function countdownLabel(seconds: number | null): string {
  return seconds === null ? '—' : `${seconds}s`;
}
