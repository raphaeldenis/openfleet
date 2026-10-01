import { DAEMON_UNREACHABLE } from '../core/error-copy';

export interface Failure {
  reason: string;
  detail: string;
}

export const NO_FAILURE: Failure = { reason: '', detail: '' };

/** Explains a failure in plain words; `detail` keeps the technical reason when the plain words replace it. */
export function failureOf(error: unknown): Failure {
  const technicalReason = error instanceof Error ? error.message : String(error);
  const isNetworkFailure = error instanceof TypeError;
  return isNetworkFailure ? { reason: DAEMON_UNREACHABLE, detail: technicalReason } : { reason: technicalReason, detail: '' };
}
