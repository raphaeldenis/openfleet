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
  // Test-only: the bodies the fake CLI actually submitted (an Enter consumed by the review notice is not one).
  readonly submitted: string[] = [];
  private composer = '';
  private isComposerUnderReview = false;

  constructor(private readonly onPromptTyped: () => void = () => undefined) {}

  write(data: string): void {
    this.written.push(data);
    if (data === '\r') this.pressEnter();
  }
  // Records the plain, unframed body: bracketed-paste framing is a ClaudeCliHarness-only concern (see
  // claudeCliHarness.test.ts), so sessionService's state-machine tests read message bodies back exactly
  // as typeNextMessage passed them in.
  typeMessage(data: string): void {
    this.written.push(data);
    this.composer = data;
    this.isComposerUnderReview = false;
    this.onPromptTyped();
  }
  private pressEnter(): void {
    const needsReview = this.reviewsInvisibleCharacters && hasInvisibleCharacters(this.composer);
    if (needsReview && !this.isComposerUnderReview) {
      this.isComposerUnderReview = true;
      // Like a real pty, the CLI's answer arrives after write() returned.
      queueMicrotask(() => this.emitData('Removed 1 invisible character · review and press Enter to send'));
      return;
    }
    if (this.composer === '') return;
    this.submitted.push(this.composer);
    this.composer = '';
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
