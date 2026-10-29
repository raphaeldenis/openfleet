const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** Formats an instant as the user's local wall clock, `2026-10-31T09:30:00`, with no offset. */
export const localDateTimeOf = (instant: Date): string => {
  const date = `${instant.getFullYear()}-${twoDigits(instant.getMonth() + 1)}-${twoDigits(instant.getDate())}`;
  const time = `${twoDigits(instant.getHours())}:${twoDigits(instant.getMinutes())}:${twoDigits(instant.getSeconds())}`;
  return `${date}T${time}`;
};

/**
 * Reads a local wall clock without offset, `YYYY-MM-DDTHH:MM` with optional `:SS` (a missing second is 0); undefined when the text has an offset, is not a date-time, or names a day that does not exist.
 * A clock-change hour is resolved silently by the platform: a time that does not exist (spring forward) lands one hour later, and an ambiguous time (fall back) reads as its first occurrence.
 */
export const instantOfLocalDateTime = (text: string): Date | undefined => {
  const match = LOCAL_DATE_TIME.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const second = Number(match[6] ?? 0);
  const instant = new Date(year, month - 1, day, hour, minute, second);
  const isRealDay = instant.getFullYear() === year && instant.getMonth() === month - 1 && instant.getDate() === day;
  return isRealDay ? instant : undefined;
};
