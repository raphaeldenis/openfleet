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

const IPV4_MAPPED_PREFIX = '::ffff:';

/** A block list reads every IPv4 address as an IPv4-mapped IPv6 one, so the mapped range cannot be a rule of the list: it is recognised on the compressed text of the address. */
const isIpv4Mapped = (ipv6Address: string): boolean => new URL(`http://[${ipv6Address}]`).hostname.slice(1, -1).startsWith(IPV4_MAPPED_PREFIX);

/**
 * True for an address on the public internet: not loopback, private, link-local, shared, multicast, reserved,
 * nor an IPv6 form (mapped, translated, 6to4) that can carry one of those.
 * A text that is not an IP address is not public.
 */
export const isPublicAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 0) return false;
  if (version === 6 && isIpv4Mapped(address)) return false;
  return !nonPublicAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6');
};
