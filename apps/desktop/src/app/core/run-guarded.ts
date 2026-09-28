import type { WritableSignal } from '@angular/core';

/**
 * Runs `action`, skipping the call entirely when `busy` is already true (guards a double click
 * before the first request settles). Clears `error` before running and sets it, if `action`
 * throws, to `message` — a fixed string, or a function of the thrown error for callers that map
 * error codes to copy — never the thrown error's own text, since a raw fetch/Error message is not
 * fit for a user to read. Always resets `busy` once `action` settles.
 */
export async function runGuarded(
  busy: WritableSignal<boolean>,
  error: WritableSignal<string | null>,
  message: string | ((error: unknown) => string),
  action: () => Promise<void>,
): Promise<void> {
  if (busy()) return;
  busy.set(true);
  error.set(null);
  try {
    await action();
  } catch (thrown) {
    error.set(typeof message === 'function' ? message(thrown) : message);
  } finally {
    busy.set(false);
  }
}
