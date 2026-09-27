import type { HarnessId, PermissionMode } from '@openfleet/shared';

export interface HarnessLaunch {
  sessionId: string;
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

export interface Harness {
  readonly id: HarnessId;
  start(launch: HarnessLaunch): HarnessHandle;
}
