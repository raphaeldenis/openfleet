import { shortId } from '../ids.js';
import { log, recentLogLines } from '../logger.js';
import { writeCrashFile, type CrashReason } from './crashFile.js';
import type { DegradedRegistry } from './degradedRegistry.js';
import { EXIT_CODES } from './exitCodes.js';

const CRASH_LOOP_WINDOW_MS = 60_000;
const ESCAPED_ERROR_MESSAGE = 'an unexpected error escaped the daemon.';

export interface ProcessGuardsOptions {
  degraded?: DegradedRegistry;
  /** Where a crash file is written; none is written without it. */
  crashDir?: string;
  /** Epoch milliseconds. */
  clock?: () => number;
  exit?: (code: number) => void;
}

const LABEL_BY_REASON: Record<CrashReason, string> = { uncaught_exception: 'uncaughtException', unhandled_rejection: 'unhandledRejection' };

function bestEffort(failure: string, step: () => void): void {
  try { step(); } catch (error) { log('warn', failure, error); }
}

// A crashed daemon takes every open PTY session down with it (the OS hangs them up), losing any turn in
// flight — far worse for a single-tenant local dev tool than marking itself degraded and carrying on.
// Request-scoped errors are already isolated by the server's own try/catch; these are the last-resort net
// for anything that still escapes it. An error caught here means something escaped every narrower boundary,
// so in-memory state (delivery machines, handle maps) may be inconsistent: every escape is logged under a
// ref, marks the daemon degraded and leaves a crash file, and a second uncaught exception within 60 s is a
// loop that ends the process with EXIT_CODES.runtimeFatal for a supervisor to restart.
export function installProcessGuards(proc: NodeJS.Process = process, options: ProcessGuardsOptions = {}): void {
  const { degraded, crashDir, clock = Date.now } = options;
  const exit = options.exit ?? ((code: number) => proc.exit(code));
  let lastUncaughtExceptionAt: number | undefined;

  const handleEscape = (error: unknown, reason: CrashReason, { isLoop }: { isLoop: boolean }): void => {
    const ref = shortId();
    const outcome = isLoop ? 'a second one within 60 s, exiting' : 'daemon continuing';
    log('error', `${LABEL_BY_REASON[reason]}: ${outcome}`, error, { id: ref, code: 'uncaught_exception' });
    bestEffort('degraded registry: marking the escaped error failed', () => degraded?.mark('uncaught_exception', ESCAPED_ERROR_MESSAGE, { id: ref }));
    if (!crashDir) return;
    bestEffort('crash file not written', () => writeCrashFile({ dir: crashDir, reason, ref, issues: degraded?.list() ?? [], logLines: recentLogLines(), now: clock }));
  };

  proc.on('unhandledRejection', (reason) => handleEscape(reason, 'unhandled_rejection', { isLoop: false }));
  proc.on('uncaughtException', (error) => {
    const now = clock();
    const isLoop = lastUncaughtExceptionAt !== undefined && now - lastUncaughtExceptionAt < CRASH_LOOP_WINDOW_MS;
    lastUncaughtExceptionAt = now;
    handleEscape(error, 'uncaught_exception', { isLoop });
    if (isLoop) exit(EXIT_CODES.runtimeFatal);
  });
  // The daemon's home holds session tokens and a db full of message bodies (MAJ-02): every file created
  // from here on (config.ts, database.ts, a session's own settings files) must default to owner-only
  // rather than trust each call site to pass its own mode.
  proc.umask(0o077);
}
