import type { WritableSignal } from '@angular/core';

/**
 * Runs `action`, skipping the call entirely when `busy` is already true (guards a double click
 * before the first request settles). Clears `error` before running and sets it to the fixed
 * `message` if `action` throws — never the thrown error's own text, since a raw fetch/Error
 * message is not fit for a user to read — then always resets `busy` once `action` settles.
 */
export async function runGuarded(
  busy: WritableSignal<boolean>,
  error: WritableSignal<string | null>,
  message: string,
  action: () => Promise<void>,
): Promise<void> {
  if (busy()) return;
  busy.set(true);
  error.set(null);
  try {
    await action();
  } catch {
    error.set(message);
  } finally {
    busy.set(false);
  }
}
