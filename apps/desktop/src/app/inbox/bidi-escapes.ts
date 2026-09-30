const BIDI_CONTROL_CHARACTERS = /[؜‎‏‪-‮⁦-⁩]/g;
const ZERO_WIDTH_CHARACTERS = /[​-‍⁠﻿]/g;

function asEscape(character: string): string {
  return `<U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;
}

export function showBidiControlsAsEscapes(text: string): string {
  return text.replace(BIDI_CONTROL_CHARACTERS, asEscape);
}

export function showInvisibleControlsAsEscapes(text: string): string {
  return showBidiControlsAsEscapes(text).replace(ZERO_WIDTH_CHARACTERS, asEscape);
}
