import type { ConversationPresence, Harness, HarnessHandle, HarnessLaunch } from './harness.js';

// What Claude Code 2.1.284 strips from a paste (measured live): zero-width and bidi format characters, BOM, soft
// hyphen, tag characters, C0 NUL and bell, the line separator; a zero-width (non-)joiner only between plain letters.
const ALWAYS_INVISIBLE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0xad, 0xad],
  [0x0, 0x0], [0x7, 0x7], [0x2028, 0x2028], [0xe0000, 0xe007f],
];
const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;
const isAsciiLetter = (codePoint: number | undefined) => codePoint !== undefined && /[a-z]/i.test(String.fromCodePoint(codePoint));

function hasInvisibleCharacters(text: string): boolean {
  const codePoints = [...text].map((character) => character.codePointAt(0)!);
  return codePoints.some((codePoint, index) => {
    const isAlwaysInvisible = ALWAYS_INVISIBLE_CODE_POINT_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
    const isJoiner = codePoint === ZERO_WIDTH_NON_JOINER || codePoint === ZERO_WIDTH_JOINER;
    const isJoinerBetweenLetters = isJoiner && isAsciiLetter(codePoints[index - 1]) && isAsciiLetter(codePoints[index + 1]);
    return isAlwaysInvisible || isJoinerBetweenLetters;
  });
}

export class FakeHandle implements HarnessHandle {
  readonly written: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  private dataListeners: ((d: string) => void)[] = [];
  private exitListeners: ((c: number) => void)[] = [];
  killed = false;
  forceKilled = false;
  // Test-only: simulates a process that doesn't react to a graceful kill, to exercise the SIGKILL escalation.
  ignoresGracefulKill = false;
  // Test-only: like a real pty, the exit arrives after kill() returned instead of inside it.
  exitsAsynchronously = false;
  killCount = 0;
  // Test-only: like Claude Code, a composer holding invisible characters strips them and answers the Enter
  // that would submit it with a notice, submitting only on the next Enter.
  reviewsInvisibleCharacters = false;
  // Test-only: how the review step behaves. The real CLI 2.1.284 shows its notice 3 ms after the Enter and ignores
  // every Enter for the next ~100-150 ms (measured live); `neverAcceptsEnter` is a composer that never leaves the review.
  // `redrawsNoticeOnIgnoredEnter`: an ignored Enter repaints the notice, so the output proves the composer still holds the paste.
  // Test-only: what the notice reads on a narrow terminal, where the CLI truncates it with an ellipsis instead of wrapping it.
  noticeText = 'Removed 1 invisible character · review and press Enter to send';
  // Test-only: a CLI that holds the paste in its composer with no notice at all (an unknown wording, a width that hides it).
  swallowsReviewSilently = false;
  reviewTiming = { noticeDelayMs: 0, ignoresEnterForMs: 0, neverAcceptsEnter: false, redrawsNoticeOnIgnoredEnter: false };
  // Test-only: a submitted turn is running until endTurn(); the fake then draws the CLI's generating marker when asked.
  showsGeneratingMarker = false;
  // Test-only: how often Escape interrupted a running turn, and how often a double Escape on an empty composer opened the rewind selector.
  interruptCount = 0;
  rewindOpenCount = 0;
  private isGenerating = false;
  // Test-only: the bodies the fake CLI actually submitted (an Enter consumed by the review notice is not one).
  readonly submitted: string[] = [];
  // Test-only: called with each body the fake CLI submitted (a test plays the hooks of the turn it starts).
  onSubmit: (body: string) => void = () => undefined;
  // Test-only: how often a double Escape emptied a composer that held text.
  composerClearCount = 0;
  private composer = '';
  private isComposerUnderReview = false;
  private noticeShownAt: number | undefined;
  private lastEscapeAt: number | undefined;

  constructor(private readonly onPromptTyped: () => void = () => undefined) {}

  // Test-only: what the composer holds right now.
  get composerText(): string { return this.composer; }

  write(data: string): void {
    this.written.push(data);
    if (data === '\r') this.pressEnter();
    if (data === '\u001b') this.pressEscape();
  }
  // Records the plain, unframed body: bracketed-paste framing is a ClaudeCliHarness-only concern (see
  // claudeCliHarness.test.ts), so sessionService's state-machine tests read message bodies back exactly
  // as typeNextMessage passed them in. Like the real composer, a paste lands after whatever it already holds.
  typeMessage(data: string): void {
    this.written.push(data);
    this.composer += data;
    this.isComposerUnderReview = false;
    this.onPromptTyped();
  }
  private pressEnter(): void {
    const needsReview = this.reviewsInvisibleCharacters && hasInvisibleCharacters(this.composer);
    if (needsReview && !this.isComposerUnderReview) {
      this.isComposerUnderReview = true;
      this.noticeShownAt = undefined;
      const showNotice = () => {
        this.noticeShownAt = Date.now();
        if (!this.swallowsReviewSilently) this.emitData(this.noticeText);
      };
      // Like a real pty, the CLI's answer arrives after write() returned.
      if (this.reviewTiming.noticeDelayMs === 0) queueMicrotask(showNotice);
      else setTimeout(showNotice, this.reviewTiming.noticeDelayMs);
      return;
    }
    if (needsReview) {
      const isIgnored = this.reviewTiming.neverAcceptsEnter
        || this.noticeShownAt === undefined
        || Date.now() - this.noticeShownAt < this.reviewTiming.ignoresEnterForMs;
      if (isIgnored) {
        if (this.reviewTiming.redrawsNoticeOnIgnoredEnter) setTimeout(() => this.emitData(this.noticeText), this.reviewTiming.noticeDelayMs);
        return;
      }
    }
    if (this.composer === '') return;
    const body = this.composer;
    this.submitted.push(body);
    this.composer = '';
    this.isComposerUnderReview = false;
    this.isGenerating = true;
    if (this.showsGeneratingMarker) queueMicrotask(() => this.emitData('✻ Working… (esc to interrupt)'));
    this.onSubmit(body);
  }
  // Test-only: the running turn ends.
  endTurn(): void { this.isGenerating = false; }
  // Like Claude Code: Escape interrupts a running turn; twice in a row it empties the composer, and on an empty
  // composer opens the rewind selector (a single Escape on an idle composer leaves everything alone).
  private pressEscape(): void {
    if (this.isGenerating) {
      this.interruptCount += 1;
      return;
    }
    const isSecondEscape = this.lastEscapeAt !== undefined && Date.now() - this.lastEscapeAt <= 1000;
    this.lastEscapeAt = isSecondEscape ? undefined : Date.now();
    if (isSecondEscape && this.composer === '') this.rewindOpenCount += 1;
    if (!isSecondEscape || this.composer === '') return;
    this.composer = '';
    this.isComposerUnderReview = false;
    this.composerClearCount += 1;
  }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  kill(options?: { force?: boolean }): void {
    this.killed = true;
    this.killCount += 1;
    if (options?.force) this.forceKilled = true;
    if (this.ignoresGracefulKill && !options?.force) return;
    if (this.exitsAsynchronously) setTimeout(() => this.emitExit(137), 0);
    else this.emitExit(137);
  }
  onData(listener: (d: string) => void): () => void {
    this.dataListeners.push(listener);
    return () => { this.dataListeners = this.dataListeners.filter((l) => l !== listener); };
  }
  onExit(listener: (c: number) => void): () => void {
    this.exitListeners.push(listener);
    return () => { this.exitListeners = this.exitListeners.filter((l) => l !== listener); };
  }
  emitData(data: string): void { for (const l of this.dataListeners) l(data); }
  emitExit(code: number): void { for (const l of this.exitListeners) l(code); }
}

export class FakeHarness implements Harness {
  readonly id = 'fake' as const;
  readonly handles: FakeHandle[] = [];
  readonly launches: HarnessLaunch[] = [];
  // Test-only: conversations the fake CLI lost (a transcript removed by its retention).
  readonly missingConversations = new Set<string>();
  // Test-only: conversations whose transcript the fake CLI cannot inspect (a permission error).
  readonly unreadableConversations = new Set<string>();
  // Like the real CLI (--session-id writes no transcript until the first prompt), a conversation started fresh has
  // no file until a prompt reaches it; a resumed or cleared one already has its file.
  private readonly freshConversationsWithoutPrompt = new Set<string>();

  // Test-only: a prompt reached this conversation from somewhere the fake cannot see (the raw terminal).
  markPrompted(cliSessionId: string): void {
    this.freshConversationsWithoutPrompt.delete(cliSessionId);
  }

  conversationExists({ cliSessionId }: { cliSessionId: string; directory: string }): ConversationPresence {
    if (this.unreadableConversations.has(cliSessionId)) return 'unknown';
    const hasNoFile = this.missingConversations.has(cliSessionId) || this.freshConversationsWithoutPrompt.has(cliSessionId);
    return hasNoFile ? 'missing' : 'present';
  }

  start(launch: HarnessLaunch): HarnessHandle {
    const conversationId = launch.cliSessionId ?? launch.sessionId;
    if (!launch.resuming) this.freshConversationsWithoutPrompt.add(conversationId);
    const handle = new FakeHandle(() => this.markPrompted(conversationId));
    this.handles.push(handle);
    this.launches.push(launch);
    return handle;
  }
}
