import type { ReproClaim } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';

const TERMINAL_COLOUR_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTERS_BUT_LINE_BREAK_AND_TAB = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const INVISIBLE_CHARACTERS = /[\u{80}-\u{9f}\u{e0000}-\u{e007f}]|\p{Cf}/gu;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const withoutControlCharacters = (text: string) => text.replace(TERMINAL_COLOUR_SEQUENCE, '').replace(CONTROL_CHARACTERS_BUT_LINE_BREAK_AND_TAB, '').replace(INVISIBLE_CHARACTERS, '');
const withLfLineBreaks = (text: string) => text.replace(/\r\n?/g, '\n');

const claimOf = (claim: string) => maskedSecrets(oneLine(withoutControlCharacters(claim)));
const commandOf = (command: string) => maskedSecrets(oneLine(withoutControlCharacters(command)));
const outputOf = (output: string) => maskedSecrets(withoutControlCharacters(withLfLineBreaks(output)).trim());

/** Cleans a claim as data: secrets masked, the claim and the command on one line, the output keeps its line breaks, terminal sequences, control characters and invisible format characters (bidi, zero-width, soft hyphen, tags, C1) removed. A command or an output left empty is dropped. */
export function sanitizedReproClaim({ claim, status, command, output }: ReproClaim): ReproClaim {
  const cleanCommand = command === undefined ? '' : commandOf(command);
  const cleanOutput = output === undefined ? '' : outputOf(output);
  return {
    claim: claimOf(claim),
    status,
    ...(cleanCommand === '' ? {} : { command: cleanCommand }),
    ...(cleanOutput === '' ? {} : { output: cleanOutput }),
  };
}

export const BLANK_CLAIM_MESSAGE = 'a claim states the defect or the check in visible text; this one is empty once control, bidi and zero-width characters are removed.';

/** A claim made only of invisible characters says nothing once cleaned. */
export const hasBlankClaim = ({ claim }: ReproClaim): boolean => claim === '';

/** A proven or plausible claim must show the run it stands on. */
export function lacksExecutedEvidence({ status, command, output }: ReproClaim): boolean {
  const isExecuted = status !== 'not_reproduced';
  const showsTheRun = command !== undefined && output !== undefined;
  return isExecuted && !showsTheRun;
}
