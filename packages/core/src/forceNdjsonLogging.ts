import { onTestFinished } from 'vitest';

/** Makes the logger print NDJSON for the running test, whatever stdout is when a worker runs it, and restores stdout afterwards. */
export function forceNdjsonLogging(): void {
  const before = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  onTestFinished(() => {
    if (before) Object.defineProperty(process.stdout, 'isTTY', before);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });
}
