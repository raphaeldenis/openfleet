import type { ConversationPresence, Harness, HarnessHandle, HarnessLaunch } from './harness.js';

export class FakeHandle implements HarnessHandle {
  readonly written: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  private dataListeners: ((d: string) => void)[] = [];
  private exitListeners: ((c: number) => void)[] = [];
  killed = false;
  forceKilled = false;
  // Test-only: simulates a process that doesn't react to a graceful kill, to exercise the SIGKILL escalation.
  ignoresGracefulKill = false;

  constructor(private readonly onPromptTyped: () => void = () => undefined) {}

  write(data: string): void { this.written.push(data); }
  // Records the plain, unframed body: bracketed-paste framing is a ClaudeCliHarness-only concern (see
  // claudeCliHarness.test.ts), so sessionService's state-machine tests read message bodies back exactly
  // as typeNextMessage passed them in.
  typeMessage(data: string): void {
    this.written.push(data);
    this.onPromptTyped();
  }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  kill(options?: { force?: boolean }): void {
    this.killed = true;
    if (options?.force) this.forceKilled = true;
    if (this.ignoresGracefulKill && !options?.force) return;
    this.emitExit(137);
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
