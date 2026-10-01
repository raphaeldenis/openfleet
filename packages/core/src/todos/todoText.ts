import { MAX_TODO_TEXT } from '@openfleet/shared';
import { maskedSecrets, maskingCutCredential } from '../redact.js';

/** A text is head-cut to twice the stored cap before anything reads it: room for the whitespace and masking that shrink it. */
export const TODO_TEXT_HEAD_LENGTH = MAX_TODO_TEXT * 2;

const ELLIPSIS = '…';

// C0 and C1 controls, DEL, line and paragraph separators, bidi marks, embeddings, overrides and isolates: each run of them, and any whitespace, becomes one space.
const CONTROL_CODE_POINT_RANGES: readonly (readonly [first: number, last: number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];
const codePointRange = ([first, last]: readonly [number, number]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`;
const CONTROLS_AND_WHITESPACE = new RegExp(`[${CONTROL_CODE_POINT_RANGES.map(codePointRange).join('')}\\s]+`, 'gu');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const isHighSurrogate = (codeUnit: number) => codeUnit >= 0xd800 && codeUnit <= 0xdbff;

const cutToMaxText = (text: string): string => {
  if (text.length <= MAX_TODO_TEXT) return text;
  const room = MAX_TODO_TEXT - ELLIPSIS.length;
  const cutsASurrogatePair = isHighSurrogate(text.charCodeAt(room - 1));
  return `${text.slice(0, cutsASurrogatePair ? room - 1 : room)}${ELLIPSIS}`;
};

/** Makes a todo text safe to store, log and draw: one line, no control or bidi character, masked, at most MAX_TODO_TEXT long. */
export function normalisedTodoText(raw: string): string {
  const wasCutByTheHead = raw.length >= TODO_TEXT_HEAD_LENGTH;
  const oneLine = raw.slice(0, TODO_TEXT_HEAD_LENGTH).replace(LONE_SURROGATE, '�').normalize('NFC').replace(CONTROLS_AND_WHITESPACE, ' ').trim();
  const withoutCutCredential = wasCutByTheHead ? maskingCutCredential(oneLine) : oneLine;
  return cutToMaxText(maskedSecrets(withoutCutCredential));
}
