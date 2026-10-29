const OBJECT_REPLACEMENT_CHARACTER = '\\u{fffc}';
const BRAILLE_BLANK = '\\u{2800}';

const INVISIBLE_OR_SPACE_ONLY = new RegExp(`^[\\p{Z}\\p{Cf}\\p{Cc}\\p{Default_Ignorable_Code_Point}\\s${BRAILLE_BLANK}${OBJECT_REPLACEMENT_CHARACTER}]*$`, 'u');

/** Tells whether a text shows nothing: empty, whitespace, Unicode spaces, control characters, format and default-ignorable characters (zero width, soft hyphen, byte order mark, fillers, variation selectors), braille blanks or object replacement characters. */
export function isBlankText(value: string): boolean {
  return INVISIBLE_OR_SPACE_ONLY.test(value);
}
