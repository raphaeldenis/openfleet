const CLOCK_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Formats an ISO instant as the local "HH:MM" wall-clock time; an unreadable instant gives an empty string. */
export function clockTimeOf(iso: string): string {
  const instant = new Date(iso);
  const isReadable = !Number.isNaN(instant.getTime());
  return isReadable ? CLOCK_TIME_FORMAT.format(instant) : '';
}
