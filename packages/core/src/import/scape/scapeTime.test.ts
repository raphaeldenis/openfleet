import { describe, expect, it } from 'vitest';
import { appleReferenceToIso, unixSecondsToIso, scapeNotesDateToIso } from './scapeTime.js';

describe('scapeTime', () => {
  it('converts an Apple reference date (seconds since 2001-01-01) to ISO', () => {
    expect(appleReferenceToIso(811089628.5)).toBe('2026-09-14T14:40:28.500Z');
  });

  it('converts unix seconds to ISO', () => {
    expect(unixSecondsToIso(1790246214.103)).toBe('2026-09-24T10:36:54.103Z');
  });

  it('reads a GRDB text date as UTC', () => {
    expect(scapeNotesDateToIso('2026-09-14 13:57:17.173')).toBe('2026-09-14T13:57:17.173Z');
  });

  it('accepts either a number or a text in the notes database', () => {
    expect(scapeNotesDateToIso(811089628.5)).toBe('2026-09-14T14:40:28.500Z');
  });

  it('refuses a value that is neither a finite number nor a parsable date', () => {
    expect(() => scapeNotesDateToIso('not a date')).toThrow(/date/);
    expect(() => scapeNotesDateToIso(null)).toThrow(/date/);
  });
});
