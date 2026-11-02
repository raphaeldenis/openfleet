import { redactedText, withoutUnrenderableCharacters } from '../logger.js';
import { maskedCommandSecrets, withoutLineContinuations } from '../policy/commandSecrets.js';
import { maskingCutCredential } from '../redact.js';

// The stored excerpts keep a few hundred characters: masking more than the bound spends the daemon's thread on text nobody reads.
const MAX_MASKED_TEXT_CHARS = 8 * 1024;

// Bash splits words on these alone: dropping them as unrenderable would glue a flag to its value. A carriage return, U+0085 or a line separator stays inside bash's word, so it is dropped and the word stays whole.
const WORD_SEPARATING_CHARACTERS = /[\t\n]/g;

/** Cuts the text at the bound before anything scans it; a credential the cut leaves too short for its rule is masked by its prefix. */
const boundedForMasking = (text: string): string => (text.length > MAX_MASKED_TEXT_CHARS ? maskingCutCredential(text.slice(0, MAX_MASKED_TEXT_CHARS)) : text);

/**
 * Returns the text cut at its bound, without control or bidirectional characters, which could split a flag name, then with every credential masked.
 * The text is masked once as written, its line breaks read as bash reads them (`cu\<line break>rl` reads `curl`, even inside `sh -c "…"`);
 * its line continuations are then taken out, a tab or a line break becomes a space, so the words on either side of it stay apart,
 * any other control or separator character is dropped, and the text is masked again.
 * Known limits, left readable: an assignment whose name holds no secret word (`X=value cmd`), a flag spelled with look-alike characters, and a value under an arbitrary name that has no recognisable format.
 */
export function maskedActivityText(text: string): string {
  const maskedAsWritten = maskedCommandSecrets(boundedForMasking(text));
  const joined = withoutLineContinuations(maskedAsWritten);
  const printable = withoutUnrenderableCharacters(joined.replace(WORD_SEPARATING_CHARACTERS, ' '));
  return redactedText(maskedCommandSecrets(printable));
}
