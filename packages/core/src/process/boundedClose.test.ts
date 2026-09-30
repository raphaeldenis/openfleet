import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeWithin } from './boundedClose.js';

afterEach(() => vi.useRealTimers());

describe('closeWithin', () => {
  it('resolves once the close is done', async () => {
    const close = vi.fn(async () => undefined);

    await closeWithin({ timeoutMs: 5000, close });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('gives up on a close that hangs once the timeout elapses', async () => {
    vi.useFakeTimers();
    let gaveUp = false;
    const waiting = closeWithin({ timeoutMs: 5000, close: () => new Promise<void>(() => undefined) }).then(() => { gaveUp = true; });

    await vi.advanceTimersByTimeAsync(4999);
    expect(gaveUp).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(gaveUp).toBe(true);
  });

  it('resolves when the close rejects, so the caller keeps its own error', async () => {
    const close = async () => { throw new Error('close failed'); };

    await expect(closeWithin({ timeoutMs: 5000, close })).resolves.toBeUndefined();
  });

  it('leaves no timer pending after a close that finishes in time', async () => {
    vi.useFakeTimers();

    await closeWithin({ timeoutMs: 5000, close: async () => undefined });

    expect(vi.getTimerCount()).toBe(0);
  });
});
