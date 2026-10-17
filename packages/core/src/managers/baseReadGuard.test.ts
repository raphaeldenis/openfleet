import { describe, expect, it } from 'vitest';
import { BASE_NOT_READ_ENFORCEMENT, baseReadVerdictOf } from './baseReadGuard.js';

const currentBase = { version: 3, sha: 'sha-v3' };
const readAt = '2026-10-15T10:00:00.000Z';
const neverRead = { baseRead: undefined };
const readCurrent = { baseRead: { ...currentBase, readAt } };
const readOlderVersion = { baseRead: { version: 2, sha: 'sha-v2', readAt } };
const readSameVersionOtherSha = { baseRead: { version: 3, sha: 'sha-edited', readAt } };

describe('baseReadVerdictOf', () => {
  it('ships in warn-only mode: the first week never refuses a spawn', () => {
    expect(BASE_NOT_READ_ENFORCEMENT).toBe('warn_only');
  });

  it('allows a manager that read the current base', () => {
    expect(baseReadVerdictOf({ record: readCurrent, currentBase })).toBe('allow');
  });

  it.each([
    ['never read the base', neverRead],
    ['read an older version', readOlderVersion],
    ['read the same version with another sha', readSameVersionOtherSha],
  ])('warns, and does not refuse, a manager that %s while warn-only', (_label, record) => {
    expect(baseReadVerdictOf({ record, currentBase })).toBe('warn');
  });

  it.each([
    ['never read the base', neverRead],
    ['read an older version', readOlderVersion],
  ])('refuses a manager that %s once enforcement is switched on', (_label, record) => {
    expect(baseReadVerdictOf({ record, currentBase, enforcement: 'refuse' })).toBe('refuse');
  });

  it('still allows a manager that read the current base once enforcement is switched on', () => {
    expect(baseReadVerdictOf({ record: readCurrent, currentBase, enforcement: 'refuse' })).toBe('allow');
  });
});
