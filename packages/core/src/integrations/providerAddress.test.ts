import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './providerAddress.js';

describe('which addresses a provider may be reached at', () => {
  it.each([
    ['a public IPv4 address', '104.192.136.30'],
    ['the first public address after the 172.16.0.0/12 range', '172.32.0.1'],
    ['the last public address before the 172.16.0.0/12 range', '172.15.255.255'],
    ['a public IPv6 address', '2606:4700:4700::1111'],
  ])('allows %s', (_label, address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, last address of its range', '127.255.255.254'],
    ['this network', '0.0.0.0'],
    ['private 10/8', '10.1.2.3'],
    ['private 172.16/12', '172.16.0.1'],
    ['private 172.16/12, last address', '172.31.255.255'],
    ['private 192.168/16', '192.168.1.1'],
    ['link-local, the cloud metadata address', '169.254.169.254'],
    ['shared address space 100.64/10', '100.64.0.1'],
    ['benchmark 198.18/15', '198.19.0.1'],
    ['multicast', '224.0.0.1'],
    ['reserved, broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 unique local', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv4-mapped IPv6 of a private address', '::ffff:10.0.0.1'],
    ['IPv4-mapped IPv6 of loopback in hex form', '::ffff:7f00:1'],
    ['NAT64 form', '64:ff9b::a00:1'],
    ['6to4 form', '2002:a00:1::'],
    ['text that is not an address', 'acme.atlassian.net'],
    ['an empty text', ''],
  ])('refuses %s', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
