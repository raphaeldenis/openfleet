import { describe, expect, it } from 'vitest';
import { showInvisibleControlsAsEscapes } from './bidi-escapes';

describe('showInvisibleControlsAsEscapes', () => {
  it.each([
    ['U+061C', '؜', '<U+061C>'],
    ['U+200B', '​', '<U+200B>'],
    ['U+202E', '‮', '<U+202E>'],
    ['U+FEFF', '﻿', '<U+FEFF>'],
    ['U+00AD', '­', '<U+00AD>'],
    ['U+034F', '͏', '<U+034F>'],
    ['U+115F', 'ᅟ', '<U+115F>'],
    ['U+1160', 'ᅠ', '<U+1160>'],
    ['U+3164', 'ㅤ', '<U+3164>'],
    ['U+FFA0', 'ﾠ', '<U+FFA0>'],
    ['U+17B4', '឴', '<U+17B4>'],
    ['U+17B5', '឵', '<U+17B5>'],
    ['U+180E', '᠎', '<U+180E>'],
    ['U+2061', '⁡', '<U+2061>'],
    ['U+2064', '⁤', '<U+2064>'],
    ['U+206A', '⁪', '<U+206A>'],
    ['U+206F', '⁯', '<U+206F>'],
    ['U+FE00', '︀', '<U+FE00>'],
    ['U+FE0F', '️', '<U+FE0F>'],
    ['U+E0000', '\u{E0000}', '<U+E0000>'],
    ['U+E0041', '\u{E0041}', '<U+E0041>'],
    ['U+E007F', '\u{E007F}', '<U+E007F>'],
  ])('shows %s as an escape', (_name, character, escape) => {
    expect(showInvisibleControlsAsEscapes(`a${character}b`)).toBe(`a${escape}b`);
  });

  it.each(['plain words', 'accents é à', 'Hangul 한글', '日本語', '😀'])('leaves %s as it is', (text) => {
    expect(showInvisibleControlsAsEscapes(text)).toBe(text);
  });
});
