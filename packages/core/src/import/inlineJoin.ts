export interface InlinePiece {
  markdown: string;
  isMentionReference: boolean;
}

const endsWithWordCharacter = (value: string) => /[A-Za-z0-9_]$/.test(value);
const startsWithMentionIdCharacter = (value: string) => /^[A-Za-z0-9_-]/.test(value);

/** Joins inline pieces, spacing a mention reference away from any word character that would glue to it. */
export const joinInlinePieces = (pieces: InlinePiece[]): string => {
  let joined = '';
  let previousWasMentionReference = false;

  for (const { markdown, isMentionReference } of pieces) {
    if (markdown === '') continue;
    const gluesToPrecedingWord = isMentionReference && endsWithWordCharacter(joined);
    const gluesToPrecedingMention = previousWasMentionReference && startsWithMentionIdCharacter(markdown);
    const separator = gluesToPrecedingWord || gluesToPrecedingMention ? ' ' : '';
    joined += separator + markdown;
    previousWasMentionReference = isMentionReference;
  }

  return joined;
};
