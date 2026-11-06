import { OpenFleetError } from '@openfleet/shared';

/** What the daemon knows of a provider: the hosts it may reach, how to ask it whether a credential works, how to present the credential. Nothing here comes from a user. */
export interface IntegrationProvider {
  id: string;
  scheme: 'https' | 'http';
  port?: number;
  isHostAllowed: (host: string) => boolean;
  /** The one read-only path a probe asks. */
  healthPath: string;
  authorizationOf: (credential: string) => string;
}

export interface IntegrationProviderRegistry {
  ids: () => string[];
  find: (providerId: string) => IntegrationProvider | undefined;
}

const bearer = (credential: string): string => `Bearer ${credential}`;
const basic = (credential: string): string => `Basic ${Buffer.from(credential).toString('base64')}`;

/** The providers of the product. Jira Cloud reaches `<tenant>.atlassian.net` and takes `email:api_token` as its credential. */
export const shippedIntegrationProviders = (): IntegrationProvider[] => [
  { id: 'jira_cloud', scheme: 'https', isHostAllowed: (host) => host.endsWith('.atlassian.net') && host.length > '.atlassian.net'.length, healthPath: '/rest/api/3/myself', authorizationOf: basic },
  { id: 'github', scheme: 'https', isHostAllowed: (host) => host === 'api.github.com', healthPath: '/rate_limit', authorizationOf: bearer },
];

export const createIntegrationProviderRegistry = (providers: IntegrationProvider[]): IntegrationProviderRegistry => {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  return { ids: () => [...providerById.keys()], find: (providerId) => providerById.get(providerId) };
};

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Returns the host in its canonical lower-case form, or throws integration_host_not_allowed: a bare host name only, which the provider itself allows. */
export const allowedHostOf = (provider: IntegrationProvider, host: string): string => {
  const canonicalHost = host.toLowerCase();
  const isBareHostName = HOST_NAME.test(canonicalHost);
  if (!isBareHostName || !provider.isHostAllowed(canonicalHost)) {
    throw new OpenFleetError('integration_host_not_allowed', `the host is not one the ${provider.id} provider may reach.`, { hint: 'give a bare host name of the provider: no scheme, port, path or user.' });
  }
  return canonicalHost;
};

export const originOf = (provider: IntegrationProvider, host: string): string => {
  const portSuffix = provider.port === undefined ? '' : `:${provider.port}`;
  return `${provider.scheme}://${host}${portSuffix}`;
};
