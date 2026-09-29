import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';

export function ageLabel(isoDate: string, nowMs: number = Date.now()): string {
  const label = compactElapsedLabel(elapsedSecondsSince(isoDate, nowMs));
  return label === null ? '—' : `${label} ago`;
}
