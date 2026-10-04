const BIDI_CONTROL_CLASS = '\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069';
const ZERO_WIDTH_CLASS = '\\u200B\\u200C\\u2060\\uFEFF';
const BLANK_LOOKING_CLASS = '\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u2061-\\u2064\\u206A-\\u206F\\u3164\\uFE00-\\uFE0D\\uFFA0\\u{E0000}-\\u{E007F}';
const JOINER = '\\u200D';

const BIDI_CONTROL_CHARACTERS = new RegExp(`[${BIDI_CONTROL_CLASS}]`, 'gu');
const ZERO_WIDTH_CHARACTERS = new RegExp(`[${ZERO_WIDTH_CLASS}]`, 'gu');
const BLANK_LOOKING_CHARACTERS = new RegExp(`[${BLANK_LOOKING_CLASS}]`, 'gu');
const JOINERS = new RegExp(JOINER, 'gu');
const VISIBLE_CHARACTER = new RegExp(`^[^\\s${BIDI_CONTROL_CLASS}${ZERO_WIDTH_CLASS}${BLANK_LOOKING_CLASS}${JOINER}]$`, 'u');

function asEscape(character: string): string {
  const codePoint = character.codePointAt(0) as number;
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
}

function isVisible(character: string | undefined): boolean {
  return character !== undefined && VISIBLE_CHARACTER.test(character);
}

/** A joiner holds an emoji sequence together only between two visible characters; anywhere else it is invisible text. */
function escapedUnlessJoiningVisibleCharacters(joiner: string, offset: number, whole: string): string {
  const characterBefore = Array.from(whole.slice(0, offset)).at(-1);
  const characterAfter = Array.from(whole.slice(offset + joiner.length))[0];
  return isVisible(characterBefore) && isVisible(characterAfter) ? joiner : asEscape(joiner);
}

export function showBidiControlsAsEscapes(text: string): string {
  return text.replace(BIDI_CONTROL_CHARACTERS, asEscape);
}

export function showInvisibleControlsAsEscapes(text: string): string {
  return showBidiControlsAsEscapes(text.replace(JOINERS, escapedUnlessJoiningVisibleCharacters))
    .replace(ZERO_WIDTH_CHARACTERS, asEscape)
    .replace(BLANK_LOOKING_CHARACTERS, asEscape);
}
