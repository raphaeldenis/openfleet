import { describe, expect, it } from 'vitest';
import { allowedHostOf, isAddressAllowedFor, shippedIntegrationProviders } from './integrationProviders.js';

const jira = shippedIntegrationProviders().find((provider) => provider.id === 'jira_cloud')!;

describe('the hosts Jira Cloud may be reached at', () => {
  it.each([
    ['a tenant', 'acme.atlassian.net', 'acme.atlassian.net'],
    ['a tenant in capitals, written in lower case', 'ACME.Atlassian.NET', 'acme.atlassian.net'],
    ['a tenant with a dash and a digit', 'acme-2.atlassian.net', 'acme-2.atlassian.net'],
    ['a punycode tenant', 'xn--caf-dma.atlassian.net', 'xn--caf-dma.atlassian.net'],
  ])('allows %s', (_label, host, canonical) => {
    expect(allowedHostOf(jira, host)).toBe(canonical);
  });

  it.each([
    ['the bare suffix', 'atlassian.net'],
    ['the suffix with a leading dot', '.atlassian.net'],
    ['a look-alike without the dot', 'evilatlassian.net'],
    ['the suffix inside another domain', 'acme.atlassian.net.evil.example'],
    ['another domain', 'acme.example.com'],
    ['a trailing dot', 'acme.atlassian.net.'],
    ['an empty label', 'acme..atlassian.net'],
    ['a port', 'acme.atlassian.net:443'],
    ['user information', 'user@acme.atlassian.net'],
    ['user information hiding the real host', 'acme.atlassian.net@evil.example'],
    ['a scheme', 'https://acme.atlassian.net'],
    ['a path', 'acme.atlassian.net/rest'],
    ['an IPv6 literal', '[::1]'],
    ['an IPv4 literal', '127.0.0.1'],
    ['a Unicode look-alike letter', 'аcme.atlassian.net'],
    ['a Unicode tenant', 'café.atlassian.net'],
    ['a blank inside', 'ac me.atlassian.net'],
    ['a backslash', 'acme.atlassian.net\\evil.example'],
    ['an empty text', ''],
  ])('refuses %s', (_label, host) => {
    expect(() => allowedHostOf(jira, host)).toThrow(expect.objectContaining({ code: 'integration_host_not_allowed' }));
  });
});

describe('the addresses a provider may be reached at', () => {
  it('allows only public addresses when the provider names no policy', () => {
    expect(isAddressAllowedFor(jira, '104.192.136.30')).toBe(true);
    expect(isAddressAllowedFor(jira, '169.254.169.254')).toBe(false);
    expect(isAddressAllowedFor(jira, '127.0.0.1')).toBe(false);
  });

  it('follows the policy a provider names', () => {
    const lenient = { ...jira, isAddressAllowed: (address: string) => address === '127.0.0.1' };

    expect(isAddressAllowedFor(lenient, '127.0.0.1')).toBe(true);
    expect(isAddressAllowedFor(lenient, '104.192.136.30')).toBe(false);
  });

  it('searches issues on a read-only path', () => {
    expect(jira.issueSearchPath).toBe('/rest/api/3/search/jql');
  });
});
