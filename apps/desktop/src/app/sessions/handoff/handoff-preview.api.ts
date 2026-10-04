import type { HandoffContent, HandoffPreview } from '@openfleet/shared';

export interface HandoffSaveResult {
  /** The path the daemon actually wrote, relative to the docs folder. */
  relativePath: string;
}

/** A failure of the port that already carries the sentence the user reads. */
export class HandoffPreviewApiError extends Error {
  constructor(readonly copy: string) {
    super(copy);
  }
}

/** What the handoff preview needs from the daemon; the host supplies the adapter. */
export interface HandoffPreviewApi {
  getPreview(sessionId: string): Promise<HandoffPreview>;
  save(sessionId: string, sections: HandoffContent): Promise<HandoffSaveResult>;
}
