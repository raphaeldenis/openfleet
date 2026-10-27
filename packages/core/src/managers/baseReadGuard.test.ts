import { describe, expect, it } from 'vitest';
import { BASE_NOT_READ_ENFORCEMENT, baseReadVerdictOf } from './baseReadGuard.js';

const currentBase = { version: 3, sha: 'sha-v3' };
const readAt = '2026-10-15T10:00:00.000Z';
const neverRead = { baseRead: undefined };
const readCurrent = { baseRead: { ...currentBase, readAt } };
const readOlderVersion = { baseRead: { version: 2, sha: 'sha-v2', readAt } };
const readSameVersionOtherSha = { baseRead: { version: 3, sha: 'sha-edited', readAt } };

describe('baseReadVerdictOf', () => {
  it('ships refusing: a spawn without the current base is refused', () => {
    expect(BASE_NOT_READ_ENFORCEMENT).toBe('refuse');
  });

  it('allows a manager that read the current base', () => {
    expect(baseReadVerdictOf({ record: readCurrent, currentBase })).toBe('allow');
  });

  it.each([
    ['never read the base', neverRead],
    ['read an older version', readOlderVersion],
    ['read the same version with another sha', readSameVersionOtherSha],
  ])('refuses by default a manager that %s', (_label, record) => {
    expect(baseReadVerdictOf({ record, currentBase })).toBe('refuse');
  });

  it.each([
    ['never read the base', neverRead],
    ['read an older version', readOlderVersion],
    ['read the same version with another sha', readSameVersionOtherSha],
  ])('only warns a manager that %s when the enforcement is injected as warn_only', (_label, record) => {
    expect(baseReadVerdictOf({ record, currentBase, enforcement: 'warn_only' })).toBe('warn');
  });
});
