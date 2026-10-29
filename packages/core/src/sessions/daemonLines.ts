export const PULSE_PREFIX = '[pulse]';
export const SCHEDULED_EVENT_PREFIX = '[scheduled event';
export const CHILD_RESTARTED_PREFIX = '[child_restarted]';
export const CHILD_RESTART_EXHAUSTED_PREFIX = '[child_restart_exhausted]';
export const HARNESS_EXITED_PREFIX = '[harness_exited]';
export const SLEEP_PREFIX = '[sleep]';
export const OPENFLEET_NOTICE_PREFIX = '[openfleet]';
export const VERDICT_PREFIX = '[verdict]';

/** The openings of the lines listed here, written by the daemon into a manager's message queue, none of them typed by a human. */
export const DAEMON_LINE_PREFIXES: readonly string[] = [
  PULSE_PREFIX,
  SCHEDULED_EVENT_PREFIX,
  CHILD_RESTARTED_PREFIX,
  CHILD_RESTART_EXHAUSTED_PREFIX,
  HARNESS_EXITED_PREFIX,
  SLEEP_PREFIX,
  OPENFLEET_NOTICE_PREFIX,
  VERDICT_PREFIX,
];

/** The SQL condition that keeps a queue query away from the daemon lines; it compares substrings because `_` is a LIKE wildcard. */
export const notADaemonLineCondition = (): string =>
  DAEMON_LINE_PREFIXES.map((prefix) => `substr(body, 1, ${prefix.length}) <> '${prefix}'`).join(' AND ');
