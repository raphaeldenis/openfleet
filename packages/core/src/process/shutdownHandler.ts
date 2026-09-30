const DEFAULT_GUARD_TIMEOUT_MS = 10_000;

export interface ShutdownHandlerOptions { guardTimeoutMs?: number }

// SIGINT and SIGTERM both map to the same shutdown, and a second signal (a user pressing Ctrl-C twice, or
// a supervisor sending TERM then KILL's gentler cousin again) must not run it a second time in parallel —
// closeAll()-ing every session twice concurrently is at best redundant, at worst racing itself (AUD-08).
// A shutdown that rejects or hangs must still exit the process with a failure code rather than leaving the
// daemon stuck or crashing on an unhandled rejection (AUD-08).
export function installShutdownHandler(shutdown: () => Promise<void>, proc: NodeJS.Process = process, options: ShutdownHandlerOptions = {}): () => void {
  const guardTimeoutMs = options.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
  let shuttingDown = false;
  const handleSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.exit(1);
    }, guardTimeoutMs);
    guard.unref?.();
    void shutdown().then(
      () => { if (settled) return; settled = true; clearTimeout(guard); proc.exit(0); },
      () => { if (settled) return; settled = true; clearTimeout(guard); proc.exit(1); },
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) proc.on(signal, handleSignal);
  return handleSignal;
}
