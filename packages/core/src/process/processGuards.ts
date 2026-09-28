import { log } from '../logger.js';

// A crashed daemon takes every open PTY session down with it (the OS hangs them up), losing any turn in
// flight — far worse for a single-tenant local dev tool than logging an unexpected error and carrying on.
// Request-scoped errors are already isolated by the server's own try/catch; these are the last-resort net
// for anything that still escapes it.
// ponytail: an error caught here means something already escaped every narrower boundary, so in-memory
// state (delivery machines, handle maps) may be inconsistent in a way logging alone can't repair. Upgrade
// path: crash instead of continuing, and let a process supervisor restart the daemon and resume sessions.
export function installProcessGuards(proc: NodeJS.Process = process): void {
  proc.on('unhandledRejection', (reason) => log('error', 'unhandledRejection: daemon continuing', reason));
  proc.on('uncaughtException', (error) => log('error', 'uncaughtException: daemon continuing', error));
}
