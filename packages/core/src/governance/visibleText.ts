const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LINE_ENDING_WITH_CARRIAGE_RETURN = /\r\n?/g;
const CONTROL_EXCEPT_NEWLINE_AND_TAB = /(?![\n\t])\p{Cc}/gu;
const FORMAT_AND_SEPARATORS = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const BLANK_LOOKING_LETTERS = /[⠀ㅤᅟᅠﾠ]/g;

/** The text as a human reads it: ANSI sequences, control and format characters (zero-width, bidi), line and paragraph separators and blank-looking letters removed; newlines and tabs kept; the edges trimmed. */
export function visibleTextOf(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, '')
    .replace(LINE_ENDING_WITH_CARRIAGE_RETURN, '\n')
    .replace(CONTROL_EXCEPT_NEWLINE_AND_TAB, '')
    .replace(FORMAT_AND_SEPARATORS, '')
    .replace(BLANK_LOOKING_LETTERS, '')
    .trim();
}
