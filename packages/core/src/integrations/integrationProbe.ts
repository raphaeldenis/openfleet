import type { IntegrationHealthStatus } from '@openfleet/shared';

export interface IntegrationProbeRequest {
  url: string;
  authorization: string;
}

/** Asks a provider whether a credential works. The answer is one of four types: no word of what the provider replied, no error text, leaves this port. */
export type IntegrationProbe = (request: IntegrationProbeRequest) => Promise<IntegrationHealthStatus>;

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const AUTH_REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const RATE_LIMITED_STATUS = 429;

const healthOfStatus = (status: number): IntegrationHealthStatus => {
  if (status >= 200 && status < 300) return 'ok';
  if (AUTH_REFUSED_STATUSES.has(status)) return 'auth_failed';
  if (status === RATE_LIMITED_STATUS) return 'rate_limited';
  return 'unreachable';
};

/**
 * The probe over fetch. A redirect is never followed: the credential goes to the host the request names and to no other.
 * The body of the answer is dropped unread, and a network failure, a timeout or a redirect reads as `unreachable`.
 */
export const createHttpIntegrationProbe = ({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {}): IntegrationProbe =>
  async ({ url, authorization }) => {
    try {
      const response = await fetch(url, { headers: { authorization, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel();
      return healthOfStatus(response.status);
    } catch {
      return 'unreachable';
    }
  };
