import { describe, expect, it } from 'vitest';
import { nextTabIndex, type TabListOrientation } from './tablist-keyboard';

const TAB_COUNT = 3;

function indexAfterKey(key: string, currentIndex: number, orientation: TabListOrientation, modifiers: KeyboardEventInit = {}) {
  return nextTabIndex(new KeyboardEvent('keydown', { key, ...modifiers }), { currentIndex, tabCount: TAB_COUNT, orientation });
}

describe('nextTabIndex', () => {
  it.each([
    ['horizontal', 'ArrowRight', 'ArrowLeft'],
    ['vertical', 'ArrowDown', 'ArrowUp'],
  ] as const)('on a %s tab list, %s steps forward and %s steps back, wrapping at both ends', (orientation, forwardKey, backwardKey) => {
    expect(indexAfterKey(forwardKey, 0, orientation)).toBe(1);
    expect(indexAfterKey(forwardKey, 1, orientation)).toBe(2);
    expect(indexAfterKey(forwardKey, 2, orientation)).toBe(0);
    expect(indexAfterKey(backwardKey, 2, orientation)).toBe(1);
    expect(indexAfterKey(backwardKey, 1, orientation)).toBe(0);
    expect(indexAfterKey(backwardKey, 0, orientation)).toBe(2);
  });

  it.each(['horizontal', 'vertical'] as const)('on a %s tab list, Home jumps to the first tab and End to the last', (orientation) => {
    expect(indexAfterKey('Home', 2, orientation)).toBe(0);
    expect(indexAfterKey('End', 0, orientation)).toBe(TAB_COUNT - 1);
  });

  it.each([
    ['horizontal', 'ArrowDown'],
    ['horizontal', 'ArrowUp'],
    ['vertical', 'ArrowRight'],
    ['vertical', 'ArrowLeft'],
  ] as const)('ignores %s-list arrow %s, which belongs to the other orientation', (orientation, key) => {
    expect(indexAfterKey(key, 1, orientation)).toBeUndefined();
  });

  it.each(['Enter', ' ', 'Tab', 'a', 'PageDown'])('leaves the %j key to the browser', (key) => {
    expect(indexAfterKey(key, 1, 'horizontal')).toBeUndefined();
    expect(indexAfterKey(key, 1, 'vertical')).toBeUndefined();
  });

  it.each([
    ['Alt', { altKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }],
  ] as const)('leaves %s+arrow, Home and End to the browser', (_modifier, modifiers) => {
    expect(indexAfterKey('ArrowRight', 0, 'horizontal', modifiers)).toBeUndefined();
    expect(indexAfterKey('ArrowDown', 0, 'vertical', modifiers)).toBeUndefined();
    expect(indexAfterKey('Home', 1, 'vertical', modifiers)).toBeUndefined();
    expect(indexAfterKey('End', 1, 'vertical', modifiers)).toBeUndefined();
  });
});
