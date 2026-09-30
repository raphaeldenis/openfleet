import { onTestFinished } from 'vitest';

/** Test-only: makes the logger print NDJSON for the running test, whatever stdout and stderr are when a worker runs it, and restores both afterwards. */
export function forceNdjsonLogging(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const before = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
    onTestFinished(() => {
      if (before) Object.defineProperty(stream, 'isTTY', before);
      else delete (stream as { isTTY?: boolean }).isTTY;
    });
  }
}
