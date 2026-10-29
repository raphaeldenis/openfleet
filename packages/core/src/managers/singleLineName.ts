export const MAX_SINGLE_LINE_NAME_LENGTH = 80;

/** Returns the name on one line: whitespace, control, format and line separator characters collapse to one space, and a name longer than the limit in characters (surrogate pairs count once) is cut with an ellipsis. */
export const toSingleLineName = (name: string): string => {
  const collapsed = name.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  const characters = Array.from(collapsed);
  const isTooLong = characters.length > MAX_SINGLE_LINE_NAME_LENGTH;
  return isTooLong ? `${characters.slice(0, MAX_SINGLE_LINE_NAME_LENGTH).join('')}…` : collapsed;
};
