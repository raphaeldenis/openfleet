import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { runGuarded } from './run-guarded';

describe('runGuarded', () => {
  it('runs the action and leaves error null on success', async () => {
    const busy = signal(false);
    const error = signal<string | null>(null);
    const action = vi.fn().mockResolvedValue(undefined);

    await runGuarded(busy, error, 'boom', action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(error()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('sets error to the fixed message, never the thrown error\'s own text', async () => {
    const busy = signal(false);
    const error = signal<string | null>(null);
    const action = vi.fn().mockRejectedValue(new Error('raw fetch failure: ECONNRESET'));

    await runGuarded(busy, error, 'Could not do the thing — try again.', action);

    expect(error()).toBe('Could not do the thing — try again.');
    expect(busy()).toBe(false);
  });

  it('clears a previous error before running again', async () => {
    const busy = signal(false);
    const error = signal<string | null>('stale error from a previous attempt');
    const action = vi.fn().mockResolvedValue(undefined);

    await runGuarded(busy, error, 'boom', action);

    expect(error()).toBeNull();
  });

  it('skips the action entirely when already busy, guarding a double click before the first request settles', async () => {
    const busy = signal(true);
    const error = signal<string | null>(null);
    const action = vi.fn().mockResolvedValue(undefined);

    await runGuarded(busy, error, 'boom', action);

    expect(action).not.toHaveBeenCalled();
    expect(busy()).toBe(true);
  });

  it('sets busy true for the duration of the action, then resets it to false once settled', async () => {
    const busy = signal(false);
    const error = signal<string | null>(null);
    let busyDuringAction = false;
    const action = vi.fn().mockImplementation(async () => {
      busyDuringAction = busy();
    });

    await runGuarded(busy, error, 'boom', action);

    expect(busyDuringAction).toBe(true);
    expect(busy()).toBe(false);
  });

  it('always resets busy to false even when the action throws', async () => {
    const busy = signal(false);
    const error = signal<string | null>(null);
    const action = vi.fn().mockRejectedValue(new Error('boom'));

    await runGuarded(busy, error, 'boom', action);

    expect(busy()).toBe(false);
  });

  it('maps the thrown error to a message via a message function, for callers whose copy varies by error', async () => {
    const busy = signal(false);
    const error = signal<string | null>(null);
    const action = vi.fn().mockRejectedValue(new Error('not_closed'));

    await runGuarded(busy, error, (thrown) => `mapped: ${(thrown as Error).message}`, action);

    expect(error()).toBe('mapped: not_closed');
  });

  describe('when the caller reports the run as stale by the time the action settles', () => {
    it('leaves busy untouched after the action succeeds', async () => {
      const busy = signal(false);
      const error = signal<string | null>(null);
      const action = vi.fn().mockResolvedValue(undefined);

      await runGuarded(busy, error, 'boom', action, { isStale: () => true });

      expect(busy()).toBe(true);
    });

    it('leaves busy and error untouched after the action throws', async () => {
      const busy = signal(false);
      const error = signal<string | null>(null);
      const action = vi.fn().mockRejectedValue(new Error('boom'));

      await runGuarded(busy, error, 'Could not do the thing — try again.', action, { isStale: () => true });

      expect(error()).toBeNull();
      expect(busy()).toBe(true);
    });

    it('still resets busy and sets the error while the run is not stale', async () => {
      const busy = signal(false);
      const error = signal<string | null>(null);
      const action = vi.fn().mockRejectedValue(new Error('boom'));

      await runGuarded(busy, error, 'Could not do the thing — try again.', action, { isStale: () => false });

      expect(error()).toBe('Could not do the thing — try again.');
      expect(busy()).toBe(false);
    });
  });
});
