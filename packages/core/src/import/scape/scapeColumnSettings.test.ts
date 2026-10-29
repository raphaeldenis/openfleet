import { describe, expect, it } from 'vitest';
import { hexOfOptionColor } from './scapeColumnSettings.js';

describe('hexOfOptionColor', () => {
  it.each([
    ['black', '#000000'], ['silver', '#c0c0c0'], ['gray', '#808080'], ['grey', '#808080'], ['white', '#ffffff'], ['maroon', '#800000'],
    ['red', '#ff0000'], ['purple', '#800080'], ['fuchsia', '#ff00ff'], ['green', '#008000'], ['lime', '#00ff00'], ['olive', '#808000'],
    ['yellow', '#ffff00'], ['navy', '#000080'], ['blue', '#0000ff'], ['teal', '#008080'], ['aqua', '#00ffff'], ['orange', '#ffa500'],
  ])('converts the standard name %s to %s', (name, hex) => {
    expect(hexOfOptionColor(name)).toBe(hex);
  });

  it.each(['#abc', '#aabbcc', '#aabbccdd'])('keeps the hex color %s', (hex) => {
    expect(hexOfOptionColor(hex)).toBe(hex);
  });

  it.each(['rebeccapurple', 'rgb(1,2,3)', '#12', '#abcd', '', 'constructor', '__proto__', 'toString'])('returns nothing for %s', (color) => {
    expect(hexOfOptionColor(color)).toBeUndefined();
  });
});
