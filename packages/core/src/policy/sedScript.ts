const SIMPLE_COMMANDS: ReadonlySet<string> = new Set(['p', 'P', 'd', 'D', 'n', 'N', 'g', 'G', 'h', 'H', 'x', '=', 'l', 'q', 'Q']);
const COMMANDS_WITH_OPTIONAL_NUMBER: ReadonlySet<string> = new Set(['l', 'q', 'Q']);
const SUBSTITUTION_FLAGS: ReadonlySet<string> = new Set(['g', 'p', 'I', 'i', 'M', 'm']);
const SEPARATORS: ReadonlySet<string> = new Set([' ', '\t', ';', '\n']);
const REFUSED = -1;

const isDigit = (character: string | undefined): boolean => character !== undefined && character >= '0' && character <= '9';

function skipSeparators(script: string, from: number): number {
  let index = from;
  while (index < script.length && SEPARATORS.has(script[index] as string)) index += 1;
  return index;
}

function skipSpaces(script: string, from: number): number {
  let index = from;
  while (script[index] === ' ' || script[index] === '\t') index += 1;
  return index;
}

function skipDigits(script: string, from: number): number {
  let index = from;
  while (isDigit(script[index])) index += 1;
  return index;
}

/** Returns the index after a part closed by `delimiter`, honouring backslash escapes, or REFUSED when it never closes. */
function skipDelimited(script: string, from: number, delimiter: string): number {
  let index = from;
  while (index < script.length) {
    if (script[index] === '\\') index += 2;
    else if (script[index] === delimiter) return index + 1;
    else index += 1;
  }
  return REFUSED;
}

function skipOneAddress(script: string, from: number): number {
  const character = script[from];
  if (isDigit(character)) {
    const afterNumber = skipDigits(script, from);
    return script[afterNumber] === '~' ? skipDigits(script, afterNumber + 1) : afterNumber;
  }
  if (character === '$') return from + 1;
  const isRegexAddress = character === '/' || character === '\\';
  if (!isRegexAddress) return from;
  const delimiter = character === '\\' ? script[from + 1] : '/';
  if (delimiter === undefined) return REFUSED;
  const afterRegex = skipDelimited(script, character === '\\' ? from + 2 : from + 1, delimiter);
  if (afterRegex === REFUSED) return REFUSED;
  return script[afterRegex] === 'I' || script[afterRegex] === 'M' ? afterRegex + 1 : afterRegex;
}

function skipAddresses(script: string, from: number): number {
  const afterFirst = skipOneAddress(script, from);
  if (afterFirst === REFUSED) return REFUSED;
  const hasRange = afterFirst > from && script[afterFirst] === ',';
  const afterRange = hasRange ? skipOneAddress(script, afterFirst + 1) : afterFirst;
  if (afterRange === REFUSED) return REFUSED;
  const afterSpaces = skipSpaces(script, afterRange);
  return script[afterSpaces] === '!' ? skipSpaces(script, afterSpaces + 1) : afterSpaces;
}

function skipSubstitution(script: string, commandIndex: number): number {
  const delimiter = script[commandIndex + 1];
  if (delimiter === undefined || delimiter === '\\' || delimiter === '\n') return REFUSED;
  const afterPattern = skipDelimited(script, commandIndex + 2, delimiter);
  if (afterPattern === REFUSED) return REFUSED;
  const afterReplacement = skipDelimited(script, afterPattern, delimiter);
  if (afterReplacement === REFUSED) return REFUSED;
  let index = afterReplacement;
  while (index < script.length && (SUBSTITUTION_FLAGS.has(script[index] as string) || isDigit(script[index]))) index += 1;
  return index;
}

function skipTransliteration(script: string, commandIndex: number): number {
  const delimiter = script[commandIndex + 1];
  if (delimiter === undefined || delimiter === '\\' || delimiter === '\n') return REFUSED;
  const afterSource = skipDelimited(script, commandIndex + 2, delimiter);
  return afterSource === REFUSED ? REFUSED : skipDelimited(script, afterSource, delimiter);
}

function skipCommand(script: string, commandIndex: number): number {
  const command = script[commandIndex];
  if (command === undefined) return REFUSED;
  if (command === 's') return skipSubstitution(script, commandIndex);
  if (command === 'y') return skipTransliteration(script, commandIndex);
  if (!SIMPLE_COMMANDS.has(command)) return REFUSED;
  return COMMANDS_WITH_OPTIONAL_NUMBER.has(command) ? skipDigits(script, commandIndex + 1) : commandIndex + 1;
}

/**
 * Tells whether a sed script only selects, prints, deletes and substitutes: no `w`/`W` file write, no `e` execution,
 * no `r` read, no blocks and no labels. A script it cannot read to the end is refused.
 */
export function isReadOnlySedScript(script: string): boolean {
  let index = skipSeparators(script, 0);
  while (index < script.length) {
    const afterAddresses = skipAddresses(script, index);
    if (afterAddresses === REFUSED) return false;
    const afterCommand = skipCommand(script, afterAddresses);
    if (afterCommand === REFUSED) return false;
    const afterSpaces = skipSpaces(script, afterCommand);
    const endsCommand = afterSpaces >= script.length || SEPARATORS.has(script[afterSpaces] as string);
    if (!endsCommand) return false;
    index = skipSeparators(script, afterSpaces);
  }
  return true;
}
