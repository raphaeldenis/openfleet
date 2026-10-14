import { WORKTREE_REFUSAL_REASONS, type ErrorEnvelope, type WorktreeRefusalReason } from '@openfleet/shared';

/** Why a worktree stays in place (`what`) and what the user does about it (`fix`). */
export interface RefusalCopy {
  what: string;
  fix?: string;
}

export const REFUSAL_COPY_BY_REASON: Record<WorktreeRefusalReason, RefusalCopy> = {
  main: { what: 'This is the main worktree of the repository and cannot be removed' },
  outside_root: { what: 'OpenFleet did not create it (it is outside its worktrees folder)', fix: 'remove it with git' },
  locked: { what: 'It is locked with git worktree lock', fix: 'unlock it with git first' },
  detached: { what: 'Its HEAD is detached, so its commits would be lost' },
  dirty: { what: 'It has uncommitted, staged or untracked files', fix: 'commit or discard them first' },
  in_use: { what: 'A session is working in it', fix: 'close that session first' },
  missing: { what: 'Its folder is gone', fix: 'prune it with git' },
  status_failed: { what: 'Git could not check its status, so it is not provably clean' },
  submodules: { what: 'It holds initialized submodules', fix: 'remove it with git' },
  removal_refused: { what: 'Git refused to remove it because it changed in the meantime' },
};

/** The refusal as a sentence for a row of the list. */
export function refusalSentence(reason: WorktreeRefusalReason): string {
  const { what, fix } = REFUSAL_COPY_BY_REASON[reason];
  return fix ? `${what} — ${fix}.` : `${what}.`;
}

const isRefusalReason = (value: unknown): value is WorktreeRefusalReason => WORKTREE_REFUSAL_REASONS.includes(value as WorktreeRefusalReason);

/** The refusal reason a daemon error carries in `detail.reason`, when it names one this app knows. */
export function refusalReasonOf(envelope: ErrorEnvelope | undefined): WorktreeRefusalReason | undefined {
  const detail = envelope?.detail;
  const reason = typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>)['reason'] : undefined;
  return isRefusalReason(reason) ? reason : undefined;
}
