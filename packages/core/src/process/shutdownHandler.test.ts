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
});
