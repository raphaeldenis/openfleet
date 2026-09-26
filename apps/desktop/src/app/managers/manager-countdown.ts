export function countdownSecondsUntil(target: string, nowMs: number): number | null {
  const targetMs = new Date(target).getTime();
  if (!Number.isFinite(targetMs)) return null;
  return Math.max(0, Math.round((targetMs - nowMs) / 1000));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function countdownLabel(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours >= 1) return `${hours}:${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`;
  return `${minutes}:${twoDigits(remainingSeconds)}`;
}
