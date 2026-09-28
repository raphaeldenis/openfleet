export function elapsedSecondsSince(since: string, nowMs: number): number | null {
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) return null;
  return Math.max(0, Math.round((nowMs - sinceMs) / 1000));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

export function compactElapsedLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds >= SECONDS_PER_DAY) return `${Math.floor(seconds / SECONDS_PER_DAY)} d`;
  if (seconds >= SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_HOUR)} h`;
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.floor(seconds / SECONDS_PER_MINUTE)} min`;
  return `${seconds} s`;
}

export function elapsedLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours >= 1) return `${hours}:${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`;
  return `${minutes}:${twoDigits(remainingSeconds)}`;
}
