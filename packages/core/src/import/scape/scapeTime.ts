import { ScapeImportError } from './scapeImportError.js';

const APPLE_REFERENCE_EPOCH_UNIX_SECONDS = 978_307_200;
const GRDB_TEXT_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export const unixSecondsToIso = (unixSeconds: number): string => new Date(Math.round(unixSeconds * 1000)).toISOString();

export const appleReferenceToIso = (appleSeconds: number): string => unixSecondsToIso(appleSeconds + APPLE_REFERENCE_EPOCH_UNIX_SECONDS);

/** Reads a date of notes.sqlite, stored as Apple reference seconds or as a GRDB UTC text. */
export function scapeNotesDateToIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return appleReferenceToIso(value);
  const isGrdbText = typeof value === 'string' && GRDB_TEXT_DATE.test(value);
  if (isGrdbText) return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
  throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `unreadable Scape date: ${String(value)}` });
}
