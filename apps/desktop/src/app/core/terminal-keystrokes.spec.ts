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

  describe('DECRPM replies written back by the terminal', () => {
    it.each([
      ['a DECRPM reply for synchronized output (mode 2026, set)', '\x1b[?2026;2$y'],
      ['a DECRPM reply reporting a reset mode', '\x1b[?1049;1$y'],
      ['several DECRPM replies in one write', '\x1b[?2026;2$y\x1b[?1049;1$y'],
    ])('does not count %s as typing', (_label, decrpmReply) => {
      expect(isUserTyping(decrpmReply)).toBe(false);
    });

    it('counts a letter typed right after a DECRPM reply as typing', () => {
      expect(isUserTyping('\x1b[?2026;2$ya')).toBe(true);
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
