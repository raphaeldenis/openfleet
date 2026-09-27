export function elapsedSecondsSince(since: string, nowMs: number): number | null {
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) return null;
  return Math.max(0, Math.round((nowMs - sinceMs) / 1000));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function elapsedLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours >= 1) return `${hours}:${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`;
  return `${minutes}:${twoDigits(remainingSeconds)}`;
}
