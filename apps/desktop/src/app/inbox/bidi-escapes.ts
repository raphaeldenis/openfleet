const BIDI_CONTROL_CHARACTERS = /[؜‎‏‪-‮⁦-⁩]/g;

export function showBidiControlsAsEscapes(text: string): string {
  return text.replace(BIDI_CONTROL_CHARACTERS, (control) => `<U+${control.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}
