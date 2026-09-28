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
    payload_too_large: `The request is too large — ${PAYLOAD_TOO_LARGE_ADVICE[kind]}.`,
    unauthorized: 'The daemon refused the app’s credentials — check the admin token.',
    daemon_shutting_down: 'The daemon is shutting down — try again in a moment.',
    internal: 'The daemon hit an internal error while creating the session — try again.',
  };
}
const CONNECTION_ERROR = 'Could not create the session — check your connection';

export const SESSION_CREATED_BUT_NOT_OPENED = 'The session was created but could not be opened — press Create again to open it. Editing the form creates a new session instead.';

export function createSessionErrorMessage(error: unknown, kind: CreatedKind): string {
  if (!(error instanceof ApiError)) return CONNECTION_ERROR;
  const messages = createErrorMessages(kind);
  const { code } = error;
  if (code && Object.hasOwn(messages, code)) return messages[code]!;
  return `Could not create the session — the daemon answered ${error.status}. Try again.`;
}
