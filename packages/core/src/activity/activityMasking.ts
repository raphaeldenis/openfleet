import { redactedText, withoutUnrenderableCharacters } from '../logger.js';
import { maskedCommandSecrets } from '../policy/commandSecrets.js';
import { maskingCutCredential } from '../redact.js';

// The stored excerpts keep a few hundred characters: masking more than the bound spends the daemon's thread on text nobody reads.
const MAX_MASKED_TEXT_CHARS = 8 * 1024;

// The shell splits words on these: dropping them as unrenderable would glue a flag to its value.
const WORD_SEPARATING_CHARACTERS = /[\t\n\v\f\r\u0085\p{Zl}\p{Zp}]/gu;

/** Cuts the text at the bound before anything scans it; a credential the cut leaves too short for its rule is masked by its prefix. */
const boundedForMasking = (text: string): string => (text.length > MAX_MASKED_TEXT_CHARS ? maskingCutCredential(text.slice(0, MAX_MASKED_TEXT_CHARS)) : text);

/**
 * Returns the text cut at its bound, without control or bidirectional characters, which could split a flag name, then with every credential masked.
 * A tab or a line break becomes a space, so the words on either side of it stay apart.
 * Known limits, left readable: an assignment whose name holds no secret word (`X=value cmd`), a flag spelled with look-alike characters, and a value under an arbitrary name that has no recognisable format.
 */
export function maskedActivityText(text: string): string {
  const printable = withoutUnrenderableCharacters(boundedForMasking(text).replace(WORD_SEPARATING_CHARACTERS, ' '));
  return redactedText(maskedCommandSecrets(printable));
}
