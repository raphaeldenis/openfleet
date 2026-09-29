import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';

export function ageLabel(isoDate: string, nowMs: number = Date.now()): string {
  const label = compactElapsedLabel(elapsedSecondsSince(isoDate, nowMs));
  return label === null ? '—' : `${label} ago`;
}

/** Returns the local date and time an ISO date falls on, or null when the date cannot be read. */
export function absoluteDateLabel(isoDate: string): string | null {
  const date = new Date(isoDate);
  const isReadable = !Number.isNaN(date.getTime());
  return isReadable ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
}
