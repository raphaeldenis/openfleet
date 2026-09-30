/** The daemon's exit codes, a supervisor's contract (error-handling spec §7). */
export const EXIT_CODES = {
  /** Nothing to do. */
  cleanShutdown: 0,
  /** Refused boot (config, port, db, permissions) or a shutdown that rejected: do not restart, show the stderr line. */
  failed: 1,
  /** Runtime fatal, an uncaught-exception loop: restart and resume the sessions. */
  runtimeFatal: 2,
  /** Shutdown still running past the guard timeout: a restart is safe, SQLite left nothing half-written. */
  shutdownHung: 3,
} as const;
