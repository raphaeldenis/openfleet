const BIDI_CONTROL_CHARACTERS = /[؜‎‏‪-‮⁦-⁩]/gu;
const ZERO_WIDTH_CHARACTERS = /[​-‍⁠﻿]/gu;
const BLANK_LOOKING_CHARACTERS = /[­͏ᅟᅠ឴឵᠎⁡-⁤⁪-⁯ㅤ︀-️ﾠ\u{E0000}-\u{E007F}]/gu;

function asEscape(character: string): string {
  const codePoint = character.codePointAt(0) as number;
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
}

export function showBidiControlsAsEscapes(text: string): string {
  return text.replace(BIDI_CONTROL_CHARACTERS, asEscape);
}

export function showInvisibleControlsAsEscapes(text: string): string {
  return showBidiControlsAsEscapes(text).replace(ZERO_WIDTH_CHARACTERS, asEscape).replace(BLANK_LOOKING_CHARACTERS, asEscape);
}
