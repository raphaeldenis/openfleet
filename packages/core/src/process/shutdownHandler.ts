// SIGINT and SIGTERM both map to the same shutdown, and a second signal (a user pressing Ctrl-C twice, or
// a supervisor sending TERM then KILL's gentler cousin again) must not run it a second time in parallel —
// closeAll()-ing every session twice concurrently is at best redundant, at worst racing itself (AUD-08).
export function installShutdownHandler(shutdown: () => Promise<void>, proc: NodeJS.Process = process): void {
  let shuttingDown = false;
  const handleSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().then(() => proc.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) proc.on(signal, handleSignal);
}
