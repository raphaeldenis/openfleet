import { BlockList, isIP } from 'node:net';

const NON_PUBLIC_RANGES: ReadonlyArray<{ network: string; prefix: number; family: 'ipv4' | 'ipv6' }> = [
  { network: '0.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '100.64.0.0', prefix: 10, family: 'ipv4' },
  { network: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { network: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { network: '192.0.0.0', prefix: 24, family: 'ipv4' },
  { network: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { network: '198.18.0.0', prefix: 15, family: 'ipv4' },
  { network: '224.0.0.0', prefix: 4, family: 'ipv4' },
  { network: '240.0.0.0', prefix: 4, family: 'ipv4' },
  { network: '::', prefix: 128, family: 'ipv6' },
  { network: '::1', prefix: 128, family: 'ipv6' },
  { network: '64:ff9b::', prefix: 96, family: 'ipv6' },
  { network: '2002::', prefix: 16, family: 'ipv6' },
  { network: 'fc00::', prefix: 7, family: 'ipv6' },
  { network: 'fe80::', prefix: 10, family: 'ipv6' },
  { network: 'ff00::', prefix: 8, family: 'ipv6' },
];

const nonPublicAddresses = new BlockList();
for (const { network, prefix, family } of NON_PUBLIC_RANGES) nonPublicAddresses.addSubnet(network, prefix, family);

/**
 * True for an address on the public internet: not loopback, private, link-local, shared, multicast, reserved,
 * nor an IPv6 form (translated, 6to4) that can carry one of those. The block list reads an IPv4-mapped IPv6 address as its IPv4 address, so a mapped private address is refused by the IPv4 rules.
 * A text that is not an IP address is not public.
 */
export const isPublicAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 0) return false;
  return !nonPublicAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6');
};
