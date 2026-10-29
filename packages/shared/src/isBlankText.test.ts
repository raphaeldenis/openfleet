import { describe, expect, it } from 'vitest';
import { isBlankText } from './isBlankText.js';

describe('isBlankText', () => {
  it.each([
    ['an empty string', ''],
    ['ascii whitespace', ' \n\t'],
    ['a zero width space', '​'],
    ['a zero width non-joiner', '‌'],
    ['a zero width joiner', '‍'],
    ['a word joiner', '⁠'],
    ['a soft hyphen', '­'],
    ['a braille blank', '⠀'],
    ['a byte order mark', '﻿'],
    ['a no-break space', ' '],
    ['an em space', ' '],
    ['an ideographic space', '　'],
    ['a mix of invisible characters', ' ​⠀﻿\n'],
    ['a hangul choseong filler', String.fromCodePoint(0x115f)],
    ['a hangul jungseong filler', String.fromCodePoint(0x1160)],
    ['a hangul filler', String.fromCodePoint(0x3164)],
    ['a halfwidth hangul filler', String.fromCodePoint(0xffa0)],
    ['a combining grapheme joiner', String.fromCodePoint(0x034f)],
    ['a khmer inherent vowel', String.fromCodePoint(0x17b4)],
    ['variation selector 16', String.fromCodePoint(0xfe0f)],
    ['variation selector 1', String.fromCodePoint(0xfe00)],
    ['a NUL character', String.fromCodePoint(0x0000)],
    ['a next line control', String.fromCodePoint(0x0085)],
    ['a DEL character', String.fromCodePoint(0x007f)],
    ['an object replacement character', String.fromCodePoint(0xfffc)],
  ])('tells %s is blank', (_name, value) => {
    expect(isBlankText(value)).toBe(true);
  });

  it.each([
    ['a word', 'checked'],
    ['a word between invisible characters', '​ok⠀'],
  ])('tells %s is not blank', (_name, value) => {
    expect(isBlankText(value)).toBe(false);
  });
});
