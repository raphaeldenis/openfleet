import { describe, expect, it } from 'vitest';
import { isUserTyping } from './terminal-keystrokes.js';

describe('isUserTyping', () => {
  describe('mouse reports written back by the terminal', () => {
    it.each([
      ['an SGR button press', '\x1b[<0;12;5M'],
      ['an SGR button release', '\x1b[<0;12;5m'],
      ['an SGR wheel event', '\x1b[<64;3;4M'],
      ['several SGR reports in one write', '\x1b[<0;12;5M\x1b[<0;12;5m\x1b[<64;3;4M'],
      ['a legacy X10 report', '\x1b[M #!'],
    ])('does not count %s as typing', (_label, mouseReport) => {
      expect(isUserTyping(mouseReport)).toBe(false);
    });
  });

  describe('real keys', () => {
    it.each([
      ['a letter', 'a'],
      ['Enter', '\r'],
      ['an arrow key', '\x1b[A'],
    ])('counts %s as typing', (_label, keys) => {
      expect(isUserTyping(keys)).toBe(true);
    });

    it('counts a letter typed right after a mouse report as typing', () => {
      expect(isUserTyping('\x1b[<0;12;5Ma')).toBe(true);
    });

    it('counts a letter typed right after a legacy X10 report as typing', () => {
      expect(isUserTyping('\x1b[M #!a')).toBe(true);
    });
  });
});
