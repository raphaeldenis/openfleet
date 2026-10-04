import type { CloseHandoffResult } from '@openfleet/shared';
import { describeError } from '../errors/describeError.js';
import { log } from '../logger.js';
import type { DocsFolderService } from './docsFolderService.js';
import type { HandoffService } from './handoffService.js';

export type WriteHandoffOnClose = (sessionId: string) => CloseHandoffResult;

export interface CloseHandoffWriterDeps {
  handoffs: Pick<HandoffService, 'reasonToSkipAutoHandoff' | 'writeAutoOnClose'>;
  docs: Pick<DocsFolderService, 'docsRelativePath'>;
}

/** Writes the handoff a user asked for while closing a session. It never throws: a failure is reported in the result so the close goes on. */
export function createCloseHandoffWriter({ handoffs, docs }: CloseHandoffWriterDeps): WriteHandoffOnClose {
  return (sessionId) => {
    const reasonToSkip = handoffs.reasonToSkipAutoHandoff(sessionId);
    if (reasonToSkip) return { status: 'skipped', reason: reasonToSkip };

    try {
      const note = handoffs.writeAutoOnClose(sessionId)!;
      return { status: 'written', relativePath: docs.docsRelativePath(note)! };
    } catch (error) {
      const { error: code, message } = describeError(error);
      log('warn', `handoff on close of session ${sessionId} not written: ${code}`);
      return { status: 'failed', error: code, message };
    }
  };
}
