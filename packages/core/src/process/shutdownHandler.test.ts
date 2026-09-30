import { describe, expect, it, vi } from 'vitest';
import { installShutdownHandler } from './shutdownHandler.js';

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  const proc = {
    on: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
    exit: vi.fn(),
  } as unknown as NodeJS.Process;
  return { proc, fire: (event: string) => listeners.get(event)?.() };
}

describe('installShutdownHandler', () => {
  it('listens on both SIGINT and SIGTERM', () => {
    const { proc } = fakeProcess();

    installShutdownHandler(async () => {}, proc);

    expect(proc.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(proc.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('runs the shutdown callback once even when a second signal arrives before the first finishes (AUD-08)', async () => {
    const { proc, fire } = fakeProcess();
    let resolveShutdown = () => {};
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { resolveShutdown = resolve; }));
    installShutdownHandler(shutdown, proc);

    fire('SIGTERM');
    fire('SIGINT'); // arrives while the first shutdown is still in flight

    expect(shutdown).toHaveBeenCalledTimes(1);
    resolveShutdown();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it('does not run the shutdown callback again once it has already completed', async () => {
    const { proc, fire } = fakeProcess();
    const shutdown = vi.fn(() => Promise.resolve());
    installShutdownHandler(shutdown, proc);

    fire('SIGTERM');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledTimes(1));
    fire('SIGINT');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 when the shutdown callback rejects (AUD-08)', async () => {
    const { proc, fire } = fakeProcess();
    const shutdown = vi.fn(() => Promise.reject(new Error('sessions.closeAll() failed')));
    installShutdownHandler(shutdown, proc);

    fire('SIGTERM');

    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(1));
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it('tells the process the shutdown began, once, before it runs the shutdown callback', () => {
    const { proc, fire } = fakeProcess();
    const order: string[] = [];
    installShutdownHandler(() => { order.push('shutdown'); return new Promise<void>(() => {}); }, proc, { onShutdownBegin: () => order.push('began') });

    fire('SIGTERM');
    fire('SIGINT');

    expect(order).toEqual(['began', 'shutdown']);
  });

  it('exits with code 0 when the shutdown callback resolves', async () => {
    const { proc, fire } = fakeProcess();
    installShutdownHandler(() => Promise.resolve(), proc);

    fire('SIGTERM');

    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
  });

  it('force-exits with code 3 if shutdown has not settled by the guard timeout: a supervisor may restart, nothing was half-written (AUD-08)', async () => {
    vi.useFakeTimers();
    const { proc, fire } = fakeProcess();
    const shutdown = vi.fn(() => new Promise<void>(() => {})); // never settles
    installShutdownHandler(shutdown, proc, { guardTimeoutMs: 10_000 });

    fire('SIGTERM');
    expect(proc.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(proc.exit).toHaveBeenCalledWith(3);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
