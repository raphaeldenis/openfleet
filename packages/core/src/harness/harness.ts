import type { HarnessId } from '@openfleet/shared';

export interface HarnessLaunch {
  sessionId: string;
  directory: string;
  model?: string;
  seededPrompt?: string;
  hookUrl: string;
  mcpUrl: string;
  mcpToken: string;
  displayName: string;
}

export interface HarnessHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(options?: { force?: boolean }): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
}

export interface Harness {
  readonly id: HarnessId;
  start(launch: HarnessLaunch): HarnessHandle;
}
