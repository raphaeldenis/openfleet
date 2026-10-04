import type { CloseHandoffResult, Session } from '@openfleet/shared';
import { describeError } from '../errors/describeError.js';
import { log } from '../logger.js';
import type { DocsFolderService } from './docsFolderService.js';
import type { HandoffService } from './handoffService.js';

export type WriteHandoffOnClose = (sessionId: string) => CloseHandoffResult;

export interface CloseHandoffWriterDeps {
  sessions: { get(id: string): Pick<Session, 'state'> | undefined };
  handoffs: Pick<HandoffService, 'reasonToSkipAutoHandoff' | 'writeAutoOnClose'>;
  docs: Pick<DocsFolderService, 'docsRelativePath'>;
}

/**
 * Writes the handoff a user asked for while closing a session. A session that is already closed gets none: its close is a no-op
 * and its last handoff, if any, was written then. It never throws: a failure, even a failing read of the session or project,
 * is reported in the result so the close goes on.
 */
export function createCloseHandoffWriter({ sessions, handoffs, docs }: CloseHandoffWriterDeps): WriteHandoffOnClose {
  return (sessionId) => {
    try {
      const isAlreadyClosed = sessions.get(sessionId)?.state === 'closed';
      if (isAlreadyClosed) return { status: 'skipped', reason: 'already_closed' };
      const reasonToSkip = handoffs.reasonToSkipAutoHandoff(sessionId);
      if (reasonToSkip) return { status: 'skipped', reason: reasonToSkip };

      const note = handoffs.writeAutoOnClose(sessionId)!;
      return { status: 'written', relativePath: docs.docsRelativePath(note)! };
    } catch (error) {
      const { error: code, message } = describeError(error);
      log('warn', `handoff on close of session ${sessionId} not written: ${code}`);
      return { status: 'failed', error: code, message };
    }
  };
}
