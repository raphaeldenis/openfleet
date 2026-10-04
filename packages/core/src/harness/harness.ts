import type { HarnessId, PermissionMode } from '@openfleet/shared';

export interface HarnessLaunch {
  sessionId: string;
  // The conversation a resume reattaches to, when the CLI left the launch conversation (a /clear).
  cliSessionId?: string;
  directory: string;
  model?: string;
  seededPrompt?: string;
  hookUrl: string;
  mcpUrl: string;
  mcpToken: string;
  displayName: string;
  permissionMode?: PermissionMode;
  resuming?: boolean;
}

export interface HarnessHandle {
  write(data: string): void;
  // Types a queued message's full body as one paste rather than raw keystrokes (see
  // claudeCli/bracketedPaste.ts): only sessionService.typeNextMessage calls this. Raw input — the
  // interrupt Escape, the terminal view's keystrokes, the submit '\r' — always goes through write().
  typeMessage(body: string): void;
  resize(cols: number, rows: number): void;
  kill(options?: { force?: boolean }): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
}

// 'unknown' is a conversation the harness could not inspect (a permission or filesystem error): it is neither
// resumable for sure nor gone for sure.
export type ConversationPresence = 'present' | 'missing' | 'unknown';

export interface Harness {
  readonly id: HarnessId;
  start(launch: HarnessLaunch): HarnessHandle;
  // Whether a resume of this conversation can succeed: the CLI refuses (exit 1) a conversation it has no file for.
  // A harness that cannot tell omits it and its conversations are assumed to exist.
  conversationExists?(conversation: { cliSessionId: string; directory: string }): ConversationPresence;
  // Read-only: a description of the project-level settings in `directory` that would loosen the harness's permission gate, if its
  // CLI would read them. A harness whose CLI reads no project settings omits it.
  findProjectSettingsWarning?(directory: string): string | undefined;
}
