// A crashed daemon takes every open PTY session down with it (the OS hangs them up), losing any turn in
// flight — far worse for a single-tenant local dev tool than logging an unexpected error and carrying on.
// Request-scoped errors are already isolated by the server's own try/catch; these are the last-resort net
// for anything that still escapes it.
export function installProcessGuards(proc: NodeJS.Process = process): void {
  proc.on('unhandledRejection', (reason) => console.error('unhandledRejection: daemon continuing', reason));
  proc.on('uncaughtException', (error) => console.error('uncaughtException: daemon continuing', error));
}
