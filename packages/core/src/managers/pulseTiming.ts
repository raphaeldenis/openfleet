export function nextPulseAt(record: { pulseSeconds: number; lastPulseAt?: string; createdAt: string }): string {
  const base = record.lastPulseAt ?? record.createdAt;
  return new Date(new Date(base).getTime() + record.pulseSeconds * 1000).toISOString();
}
