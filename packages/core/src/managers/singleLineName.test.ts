import { describe, expect, it } from 'vitest';
import { MAX_SINGLE_LINE_NAME_LENGTH, toSingleLineName } from './singleLineName.js';

describe('toSingleLineName', () => {
  it('collapses whitespace and control characters to one space', () => {
    expect(toSingleLineName('  Fix\n\tthe   login\u0007bug  ')).toBe('Fix the login bug');
  });

  it.each([
    ['a zero-width space', 'Fix​the bug'],
    ['a right-to-left override', 'Fix‮the bug'],
    ['a byte order mark', 'Fix﻿the bug'],
  ])('collapses %s, a format character, to one space', (_label, name) => {
    expect(toSingleLineName(name)).toBe('Fix the bug');
  });

  it('keeps a name of exactly the limit untouched', () => {
    const name = 'a'.repeat(MAX_SINGLE_LINE_NAME_LENGTH);

    expect(toSingleLineName(name)).toBe(name);
  });

  it('cuts a longer name with an ellipsis', () => {
    expect(toSingleLineName('a'.repeat(MAX_SINGLE_LINE_NAME_LENGTH + 5))).toBe(`${'a'.repeat(MAX_SINGLE_LINE_NAME_LENGTH)}…`);
  });

  it('never cuts a surrogate pair in half', () => {
    const name = '😀'.repeat(MAX_SINGLE_LINE_NAME_LENGTH + 1);

    const cut = toSingleLineName(name);

    expect(cut).toBe(`${'😀'.repeat(MAX_SINGLE_LINE_NAME_LENGTH)}…`);
  });

  it('does not cut a name whose pairs bring it under the limit in characters but over it in UTF-16 units', () => {
    const name = '😀'.repeat(MAX_SINGLE_LINE_NAME_LENGTH);

    expect(toSingleLineName(name)).toBe(name);
  });
});
