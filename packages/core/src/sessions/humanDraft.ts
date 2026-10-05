const ESCAPE = '\x1b';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const BACKSPACE = '\b';
const DELETE = '\x7f';
const BACKSLASH = '\\';
const CTRL_C = '\x03';
const CTRL_U = '\x15';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
// Ctrl-D, Ctrl-K, Ctrl-T, Ctrl-W, Ctrl-Y: they delete, move or paste text the daemon cannot count.
const EDITING_CONTROLS = new Set(['\x04', '\x0b', '\x14', '\x17', '\x19']);
// An Up or Down arrow recalls a previous prompt into the empty prompt: the daemon never sees what came back.
const HISTORY_FINAL_BYTES = new Set(['A', 'B']);
const FIRST_PRINTABLE_CODE_POINT = 0x20;

// Claude Code empties its prompt on two Escapes pressed this close together.
export const DOUBLE_ESCAPE_WINDOW_MS = 1000;

const isControl = (character: string) => character.codePointAt(0)! < FIRST_PRINTABLE_CODE_POINT;
const isFinalByteOfEscapeSequence = (character: string) => /[@-~]/.test(character);

// Whether the prompt of the terminal may hold text the human typed and did not send, read from the bytes the human's
// keyboard sent. It counts what it can see (typed characters, pastes, backspaces) and treats every edit it cannot
// count (history recall, forward delete, word kills) as "something is there" until the prompt is provably emptied.
export class HumanDraft {
  private typedCharacterCount = 0;
  private mayHoldUnseenText = false;
  private lastCharacter = '';
  private lastLoneEscapeAt: number | undefined;

  get isPresent(): boolean {
    return this.typedCharacterCount > 0 || this.mayHoldUnseenText;
  }

  clear(): void {
    this.typedCharacterCount = 0;
    this.mayHoldUnseenText = false;
    this.lastCharacter = '';
    this.lastLoneEscapeAt = undefined;
  }

  observe(keys: string, nowMs: number): void {
    const characters = Array.from(keys);
    let index = 0;
    while (index < characters.length) {
      const isEscapeStart = characters[index] === ESCAPE;
      index = isEscapeStart ? this.readEscape(characters, index, nowMs) : this.press(characters, index);
    }
  }

  private press(characters: string[], index: number): number {
    const key = characters[index]!;
    this.lastLoneEscapeAt = undefined;
    const isSubmit = key === CARRIAGE_RETURN || key === LINE_FEED;
    const isLineContinuation = isSubmit && this.lastCharacter === BACKSLASH;
    const isErase = key === DELETE || key === BACKSPACE;
    if (isSubmit && !isLineContinuation) this.clear();
    else if (key === CTRL_C || key === CTRL_U) this.clear();
    else if (isErase) this.typedCharacterCount = Math.max(0, this.typedCharacterCount - 1);
    else if (EDITING_CONTROLS.has(key)) this.mayHoldUnseenText = true;
    else if (!isControl(key)) this.typedCharacterCount += 1;
    if (this.isPresent) this.lastCharacter = key;
    return index + 1;
  }

  private readEscape(characters: string[], index: number, nowMs: number): number {
    const following = characters[index + 1];
    if (following === undefined) return this.pressLoneEscape(index, nowMs);
    this.lastLoneEscapeAt = undefined;
    if (following === '[') return this.readControlSequence(characters, index);
    if (following === 'O') return this.readSingleShift(characters, index);
    const isAltErase = following === DELETE || following === BACKSPACE;
    if (isAltErase) this.mayHoldUnseenText = true;
    return index + 2;
  }

  private pressLoneEscape(index: number, nowMs: number): number {
    const isSecondEscape = this.lastLoneEscapeAt !== undefined && nowMs - this.lastLoneEscapeAt <= DOUBLE_ESCAPE_WINDOW_MS;
    if (isSecondEscape) this.clear();
    else this.lastLoneEscapeAt = nowMs;
    return index + 1;
  }

  private readControlSequence(characters: string[], index: number): number {
    const isBracketedPaste = characters.slice(index, index + BRACKETED_PASTE_START.length).join('') === BRACKETED_PASTE_START;
    if (isBracketedPaste) return this.readBracketedPaste(characters, index);
    let finalByteIndex = index + 2;
    while (finalByteIndex < characters.length && !isFinalByteOfEscapeSequence(characters[finalByteIndex]!)) finalByteIndex += 1;
    const parameters = characters.slice(index + 2, finalByteIndex).join('');
    const finalByte = characters[finalByteIndex] ?? '';
    const isForwardDelete = parameters === '3' && finalByte === '~';
    if (HISTORY_FINAL_BYTES.has(finalByte) || isForwardDelete) this.mayHoldUnseenText = true;
    return finalByteIndex + 1;
  }

  private readSingleShift(characters: string[], index: number): number {
    const finalByte = characters[index + 2] ?? '';
    if (HISTORY_FINAL_BYTES.has(finalByte)) this.mayHoldUnseenText = true;
    return index + 3;
  }

  private readBracketedPaste(characters: string[], index: number): number {
    const afterStart = characters.slice(index + BRACKETED_PASTE_START.length).join('');
    const endIndex = afterStart.indexOf(BRACKETED_PASTE_END);
    const hasEnd = endIndex !== -1;
    const pasted = hasEnd ? afterStart.slice(0, endIndex) : afterStart;
    this.typedCharacterCount += Array.from(pasted).length;
    if (!hasEnd) return characters.length;
    const consumedAfterStart = Array.from(afterStart.slice(0, endIndex + BRACKETED_PASTE_END.length)).length;
    return index + BRACKETED_PASTE_START.length + consumedAfterStart;
  }
}
