// The text a terminal composer ends up holding after a bracketed paste of `body`. The body's own ESC bytes are
// stripped: left in, an embedded paste-end sequence would close the paste early. Line breaks (CRLF, lone CR)
// become one '\n' each so lines never merge; every other C0/C1 control character goes too except tab and newline.
const LINE_BREAK = /\r\n?/g;
const CONTROL_CHARACTERS_EXCEPT_TAB_AND_NEWLINE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function textTypedByPaste(body: string): string {
  const withNewlineLineBreaks = body.replace(LINE_BREAK, '\n');
  return withNewlineLineBreaks.replace(CONTROL_CHARACTERS_EXCEPT_TAB_AND_NEWLINE, '');
}
