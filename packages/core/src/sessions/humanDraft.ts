const ESCAPE = '\x1b';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const BACKSPACE = '\b';
const DELETE = '\x7f';
const BACKSLASH = '\\';
const CTRL_C = '\x03';
const CTRL_U = '\x15';
const BRACKETED_PASTE_PARAMETERS = '200';
const BRACKETED_PASTE_END = '\x1b[201~';
// Ctrl-D, Ctrl-K, Ctrl-T, Ctrl-W, Ctrl-Y: they delete, move or paste text the daemon cannot count.
const EDITING_CONTROLS = new Set(['\x04', '\x0b', '\x14', '\x17', '\x19']);
// Ctrl-A, Ctrl-B, Ctrl-E, Ctrl-F: they move the cursor, so a later erase may leave text the daemon cannot count.
const CURSOR_CONTROLS = new Set(['\x01', '\x02', '\x05', '\x06']);
// An Up or Down arrow recalls a previous prompt into the empty prompt: the daemon never sees what came back.
const HISTORY_FINAL_BYTES = new Set(['A', 'B']);
// Right, Left, Home, End.
const CURSOR_FINAL_BYTES = new Set(['C', 'D', 'H', 'F']);
// ESC [ 1 ~ , 4 ~ , 7 ~ , 8 ~ : Home and End as some terminals send them.
const CURSOR_TILDE_PARAMETERS = new Set(['1', '4', '7', '8']);
const FIRST_PRINTABLE_CODE_POINT = 0x20;

// Claude Code empties its prompt on two Escapes pressed this close together.
export const DOUBLE_ESCAPE_WINDOW_MS = 1000;
// An Escape starts a key sequence (Shift+Enter, Alt+key) only when its next byte follows within this delay; later it was a key of its own.
export const ESCAPE_FOLLOW_UP_WINDOW_MS = 250;

const isControl = (character: string) => character.codePointAt(0)! < FIRST_PRINTABLE_CODE_POINT;
const isParameterByteOfControlSequence = (character: string) => /[ -?]/.test(character);
const isFinalByteOfControlSequence = (character: string) => /[@-~]/.test(character);

type ReadingMode = 'keys' | 'escape' | 'control-sequence' | 'single-shift' | 'paste';

// Whether the prompt of the terminal may hold text the human typed and did not send, read from the bytes the human's
// keyboard sent. It counts what it can see (typed characters, pastes, backspaces) and treats every edit it cannot
// count (history recall, forward delete, word kills, an erase with the cursor moved or on a multi-line prompt) as
// "something is there". Only a submit, Ctrl-C or two Escapes (and Ctrl-U or Backspaces on a plain single line) prove the prompt empty.
// The bytes are read as one stream: an escape sequence or a paste cut by a chunk boundary reads the same as an uncut one.
export class HumanDraft {
  private typedCharacterCount = 0;
  private mayHoldUnseenText = false;
  private eraseMayLeaveText = false;
  private lastCharacter = '';
  private lastLoneEscapeAt: number | undefined;
  private mode: ReadingMode = 'keys';
  private pendingEscapeAt = 0;
  private controlSequenceParameters = '';
  private pasteEndCandidate = '';

  get isPresent(): boolean {
    return this.typedCharacterCount > 0 || this.mayHoldUnseenText;
  }

  observe(keys: string, nowMs: number): void {
    this.settleStalePendingEscape(nowMs);
    for (const character of keys) this.read(character, nowMs);
  }

  private read(character: string, nowMs: number): void {
    if (this.mode === 'keys') this.readKey(character, nowMs);
    else if (this.mode === 'escape') this.readAfterEscape(character, nowMs);
    else if (this.mode === 'control-sequence') this.readControlSequenceByte(character, nowMs);
    else if (this.mode === 'single-shift') this.readSingleShiftByte(character);
    else this.readPastedCharacter(character);
  }

  private readKey(character: string, nowMs: number): void {
    const isEscapeStart = character === ESCAPE;
    if (isEscapeStart) this.beginEscape(nowMs);
    else this.press(character);
  }

  private empty(): void {
    this.typedCharacterCount = 0;
    this.mayHoldUnseenText = false;
    this.eraseMayLeaveText = false;
    this.lastCharacter = '';
    this.lastLoneEscapeAt = undefined;
  }

  private press(key: string): void {
    this.lastLoneEscapeAt = undefined;
    const isSubmit = key === CARRIAGE_RETURN || key === LINE_FEED;
    const isLineContinuation = isSubmit && this.lastCharacter === BACKSLASH;
    const isErase = key === DELETE || key === BACKSPACE;
    if (isLineContinuation) return this.addLine();
    if (isSubmit || key === CTRL_C) return this.empty();
    if (key === CTRL_U) return this.killToLineStart();
    if (isErase) this.eraseBackward();
    else if (EDITING_CONTROLS.has(key)) this.mayHoldUnseenText = true;
    else if (CURSOR_CONTROLS.has(key)) this.moveCursorAway();
    else if (!isControl(key)) this.typedCharacterCount += 1;
    if (this.isPresent) this.lastCharacter = key;
  }

  private addLine(): void {
    this.lastCharacter = LINE_FEED;
    if (this.isPresent) this.eraseMayLeaveText = true;
  }

  private moveCursorAway(): void {
    if (this.isPresent) this.eraseMayLeaveText = true;
  }

  private killToLineStart(): void {
    if (this.eraseMayLeaveText) this.mayHoldUnseenText = true;
    else this.empty();
  }

  private eraseBackward(): void {
    if (this.eraseMayLeaveText) this.mayHoldUnseenText = true;
    else this.typedCharacterCount = Math.max(0, this.typedCharacterCount - 1);
  }

  private recallHistory(): void {
    this.mayHoldUnseenText = true;
    this.eraseMayLeaveText = true;
  }

  private beginEscape(nowMs: number): void {
    const isSecondEscape = this.lastLoneEscapeAt !== undefined && nowMs - this.lastLoneEscapeAt <= DOUBLE_ESCAPE_WINDOW_MS;
    if (isSecondEscape) return this.empty();
    this.mode = 'escape';
    this.pendingEscapeAt = nowMs;
  }

  private settleStalePendingEscape(nowMs: number): void {
    const isEscapePending = this.mode === 'escape';
    const isStale = nowMs - this.pendingEscapeAt > ESCAPE_FOLLOW_UP_WINDOW_MS;
    if (!isEscapePending || !isStale) return;
    this.lastLoneEscapeAt = this.pendingEscapeAt;
    this.mode = 'keys';
  }

  private readAfterEscape(character: string, nowMs: number): void {
    if (character === ESCAPE) {
      this.lastLoneEscapeAt = this.pendingEscapeAt;
      this.mode = 'keys';
      return this.beginEscape(nowMs);
    }
    this.lastLoneEscapeAt = undefined;
    if (character === '[') return this.beginControlSequence();
    if (character === 'O') return void (this.mode = 'single-shift');
    this.mode = 'keys';
    const isShiftEnter = character === CARRIAGE_RETURN || character === LINE_FEED;
    const isAltErase = character === DELETE || character === BACKSPACE;
    if (isShiftEnter) this.addLine();
    else if (isAltErase) this.mayHoldUnseenText = true;
    else this.moveCursorAway();
  }

  private beginControlSequence(): void {
    this.mode = 'control-sequence';
    this.controlSequenceParameters = '';
  }

  private readControlSequenceByte(character: string, nowMs: number): void {
    if (isParameterByteOfControlSequence(character)) {
      this.controlSequenceParameters += character;
      return;
    }
    this.mode = 'keys';
    const isFinalByte = isFinalByteOfControlSequence(character);
    if (isFinalByte) this.finishControlSequence(this.controlSequenceParameters, character);
    else this.read(character, nowMs);
  }

  private finishControlSequence(parameters: string, finalByte: string): void {
    const isBracketedPasteStart = finalByte === '~' && parameters === BRACKETED_PASTE_PARAMETERS;
    if (isBracketedPasteStart) return this.beginPaste();
    const isForwardDelete = parameters === '3' && finalByte === '~';
    const isCursorTilde = finalByte === '~' && CURSOR_TILDE_PARAMETERS.has(parameters);
    if (HISTORY_FINAL_BYTES.has(finalByte)) this.recallHistory();
    else if (isForwardDelete) this.mayHoldUnseenText = true;
    else if (CURSOR_FINAL_BYTES.has(finalByte) || isCursorTilde) this.moveCursorAway();
  }

  private readSingleShiftByte(finalByte: string): void {
    this.mode = 'keys';
    if (HISTORY_FINAL_BYTES.has(finalByte)) this.recallHistory();
    else if (CURSOR_FINAL_BYTES.has(finalByte)) this.moveCursorAway();
  }

  private beginPaste(): void {
    this.mode = 'paste';
    this.pasteEndCandidate = '';
  }

  private readPastedCharacter(character: string): void {
    const candidate = this.pasteEndCandidate + character;
    if (candidate === BRACKETED_PASTE_END) return this.finishPaste();
    const isEndMarkerProgress = BRACKETED_PASTE_END.startsWith(candidate);
    if (isEndMarkerProgress) {
      this.pasteEndCandidate = candidate;
      return;
    }
    Array.from(this.pasteEndCandidate).forEach((abandoned) => this.countPastedCharacter(abandoned));
    const startsNewEndMarker = character === ESCAPE;
    this.pasteEndCandidate = startsNewEndMarker ? character : '';
    if (!startsNewEndMarker) this.countPastedCharacter(character);
  }

  private countPastedCharacter(character: string): void {
    this.typedCharacterCount += 1;
    this.lastCharacter = character;
    const isNewLine = character === CARRIAGE_RETURN || character === LINE_FEED;
    if (isNewLine) this.eraseMayLeaveText = true;
  }

  private finishPaste(): void {
    this.mode = 'keys';
    this.pasteEndCandidate = '';
  }
}
