import { ApiError } from '../core/fleet-api.service';

// The error codes of the create routes (packages/core/src/api/*.ts) mapped to copy a user can act on.
const CREATE_ERROR_MESSAGES: Record<string, string> = {
  invalid_body: 'The daemon rejected these values — check the directory and the other fields.',
  payload_too_large: 'The request is too large — shorten the mission.',
  unauthorized: 'The daemon refused the app’s credentials — check the admin token.',
  daemon_shutting_down: 'The daemon is shutting down — try again in a moment.',
  internal: 'The daemon hit an internal error while creating the session — try again.',
};
const CONNECTION_ERROR = 'Could not create the session — check your connection';

export const SESSION_CREATED_BUT_NOT_OPENED = 'The session was created but could not be opened — try again to open it.';

export function createSessionErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return CONNECTION_ERROR;
  const knownMessage = error.code ? CREATE_ERROR_MESSAGES[error.code] : undefined;
  return knownMessage ?? `Could not create the session — the daemon answered ${error.status}. Try again.`;
}
