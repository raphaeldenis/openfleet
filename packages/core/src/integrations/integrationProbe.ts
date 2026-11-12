import type { IntegrationHealthStatus } from '@openfleet/shared';
import type { ProviderAnswer, ProviderGet, ProviderReader } from './providerReader.js';

/** Asks a provider whether a credential works. The answer is one of four types: no word of what the provider replied, no error text, leaves this port. */
export type IntegrationProbe = (get: ProviderGet) => Promise<IntegrationHealthStatus>;

const healthOfAnswer = (answer: ProviderAnswer): IntegrationHealthStatus => {
  if (answer.kind === 'ok') return 'ok';
  if (answer.kind === 'auth_failed') return 'auth_failed';
  if (answer.kind === 'rate_limited') return 'rate_limited';
  return 'unreachable';
};

/**
 * The probe over the pinned reader of the poller: the host is resolved once, the address passes the provider's policy, the connection goes to that address,
 * a redirect is never followed and the deadline covers the resolution. The body of the answer is read only to be dropped; a 2xx that is not JSON, a network failure,
 * a timeout, a refused address and a redirect read as `unreachable`.
 */
export const createHttpIntegrationProbe = ({ reader }: { reader: ProviderReader }): IntegrationProbe =>
  async (get) => healthOfAnswer(await reader(get));
