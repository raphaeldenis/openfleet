import type { ServerResponse } from 'node:http';
import { HTTP_STATUS_BY_KIND, type ErrorEnvelope } from '@openfleet/shared';
import { describeError, type ErrorScope } from '../errors/describeError.js';
import { json } from './router.js';

const isCurrentRevDetail = (detail: unknown): detail is { currentRev: number } =>
  typeof detail === 'object' && detail !== null && typeof (detail as { currentRev?: unknown }).currentRev === 'number';

/** The note editor reads currentRev at the top level of a stale_revision body; it stays there next to `detail` for one release. */
function bodyOf(envelope: ErrorEnvelope): ErrorEnvelope & { currentRev?: number } {
  const isStaleRevision = envelope.error === 'stale_revision' && isCurrentRevDetail(envelope.detail);
  return isStaleRevision ? { ...envelope, currentRev: (envelope.detail as { currentRev: number }).currentRev } : envelope;
}

/** The one place an error answer is written: status from the kind, the envelope as the body, the ref of an internal error in a header. */
export function answerEnvelope(res: ServerResponse, envelope: ErrorEnvelope): void {
  const errorIdHeader: Record<string, string> = envelope.id ? { 'x-openfleet-error-id': envelope.id } : {};
  json(res, HTTP_STATUS_BY_KIND[envelope.kind], bodyOf(envelope), errorIdHeader);
}

/** Describes whatever was thrown and answers it; throws only if writing the response itself fails. */
export function answerError(res: ServerResponse, error: unknown, scope?: ErrorScope): void {
  answerEnvelope(res, describeError(error, scope));
}
