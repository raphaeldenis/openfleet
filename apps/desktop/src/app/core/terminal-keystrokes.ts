const ESCAPE = '\x1b';
const BELL = '\x07';

const FOCUS_REPORT = `${ESCAPE}\\[[IO]`;
const DEVICE_AND_CURSOR_REPLY = `${ESCAPE}\\[[?>]?[\\d;]*[cRn]`;
const OSC_REPLY = `${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`;
const TERMINAL_REPORTS = new RegExp([FOCUS_REPORT, DEVICE_AND_CURSOR_REPLY, OSC_REPLY].join('|'), 'g');

/**
 * Tells what the user typed from what the terminal writes back by itself (focus reports, device attribute,
 * cursor position and status replies, OSC replies): a write is typing when something other than those reports,
 * and other than a lone Escape, is left in it.
 */
export function isUserTyping(terminalInput: string): boolean {
  const leftAfterTerminalReports = terminalInput.replace(TERMINAL_REPORTS, '');
  const isOnlyTerminalReports = leftAfterTerminalReports === '';
  const isLoneEscape = leftAfterTerminalReports === ESCAPE;
  return !isOnlyTerminalReports && !isLoneEscape;
}
