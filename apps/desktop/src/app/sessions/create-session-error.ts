import { ApiError } from '../core/fleet-api.service';

export type CreatedKind = 'session' | 'manager';

const PAYLOAD_TOO_LARGE_ADVICE: Record<CreatedKind, string> = {
  session: 'shorten the directory or the name',
  manager: 'shorten the mission',
};

// The error codes of the create routes (packages/core/src/api/*.ts) mapped to copy a user can act on.
function createErrorMessages(kind: CreatedKind): Record<string, string> {
  return {
    invalid_body: 'The daemon rejected these values — check the directory and the other fields.',
    invalid_branch_name: 'The branch name is not valid — use letters, digits, dots, dashes, underscores and slashes only.',
    worktree_exists: 'A worktree for this branch already exists — pick another branch name or remove that worktree.',
    payload_too_large: `The request is too large — ${PAYLOAD_TOO_LARGE_ADVICE[kind]}.`,
    unauthorized: 'The daemon refused the app’s credentials — check the admin token.',
    daemon_shutting_down: 'The daemon is shutting down — try again in a moment.',
    internal: `The daemon hit an internal error while creating the ${kind} — try again.`,
  };
}

export function createdButNotOpenedMessage(kind: CreatedKind): string {
  return `The ${kind} was created but could not be opened — press Create again to open it. Editing the form creates a new ${kind} instead.`;
}

export function createSessionErrorMessage(error: unknown, kind: CreatedKind): string {
  if (!(error instanceof ApiError)) return `Could not create the ${kind} — check your connection`;
  const messages = createErrorMessages(kind);
  const { code } = error;
  if (code && Object.hasOwn(messages, code)) return messages[code]!;
  return `Could not create the ${kind} — the daemon answered ${error.status}. Try again.`;
}
