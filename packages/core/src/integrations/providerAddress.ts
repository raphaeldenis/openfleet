import { BlockList, isIP } from 'node:net';

const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [network: string, prefix: number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const nonPublicIpv4Addresses = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV4_RANGES) nonPublicIpv4Addresses.addSubnet(network, prefix, 'ipv4');

const IPV6_GROUP_COUNT = 8;
const BITS_PER_GROUP = 16;

/** An IPv6 prefix written as its leading groups: `[0x2001, 0xdb8]` with 32 bits is `2001:db8::/32`. */
type Ipv6Prefix = { groups: readonly number[]; bits: number };

const GLOBAL_UNICAST: Ipv6Prefix = { groups: [0x2000], bits: 3 };
const IPV4_MAPPED: Ipv6Prefix = { groups: [0, 0, 0, 0, 0, 0xffff], bits: 96 };
const NAT64_WELL_KNOWN: Ipv6Prefix = { groups: [0x64, 0xff9b, 0, 0, 0, 0], bits: 96 };

/** Inside 2000::/3: protocol assignments (Teredo, benchmarking, ORCHID), documentation, 6to4. */
const NON_PUBLIC_INSIDE_GLOBAL_UNICAST: readonly Ipv6Prefix[] = [
  { groups: [0x2001, 0], bits: 23 },
  { groups: [0x2001, 0xdb8], bits: 32 },
  { groups: [0x2002], bits: 16 },
  { groups: [0x3fff], bits: 20 },
];

const hasPrefix = (groups: readonly number[], prefix: Ipv6Prefix): boolean => {
  for (let bit = 0; bit < prefix.bits; bit += 1) {
    const groupIndex = Math.floor(bit / BITS_PER_GROUP);
    const bitMask = 1 << (BITS_PER_GROUP - 1 - (bit % BITS_PER_GROUP));
    const addressBit = (groups[groupIndex] ?? 0) & bitMask;
    const prefixBit = (prefix.groups[groupIndex] ?? 0) & bitMask;
    if (addressBit !== prefixBit) return false;
  }
  return true;
};

const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
const DOTTED_TAIL = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/;

/** The eight 16-bit groups of a valid IPv6 text; an IPv4 tail is read as its two groups. */
const ipv6GroupsOf = (address: string): number[] => {
  const dottedTail = DOTTED_TAIL.exec(address);
  const textWithoutDottedTail = dottedTail === null ? address : `${dottedTail[1]}0:0`;
  const [head = '', tail] = textWithoutDottedTail.split('::');
  const groupsOf = (text: string): number[] => (text === '' ? [] : text.split(':').map((group) => (HEX_GROUP.test(group) ? parseInt(group, 16) : Number.NaN)));
  const headGroups = groupsOf(head);
  const tailGroups = tail === undefined ? [] : groupsOf(tail);
  const zeroGroups = Array.from({ length: tail === undefined ? 0 : IPV6_GROUP_COUNT - headGroups.length - tailGroups.length }, () => 0);
  const groups = [...headGroups, ...zeroGroups, ...tailGroups];
  if (dottedTail !== null) {
    const [first = 0, second = 0, third = 0, fourth = 0] = dottedTail[2]!.split('.').map(Number);
    groups.splice(IPV6_GROUP_COUNT - 2, 2, first * 256 + second, third * 256 + fourth);
  }
  return groups;
};

const embeddedIpv4Of = (groups: readonly number[]): string => {
  const [high = 0, low = 0] = groups.slice(IPV6_GROUP_COUNT - 2);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
};

const isPublicIpv4 = (address: string): boolean => !nonPublicIpv4Addresses.check(address, 'ipv4');

const isPublicIpv6 = (address: string): boolean => {
  const groups = ipv6GroupsOf(address);
  const carriesAnIpv4Address = hasPrefix(groups, IPV4_MAPPED) || hasPrefix(groups, NAT64_WELL_KNOWN);
  if (carriesAnIpv4Address) return isPublicIpv4(embeddedIpv4Of(groups));
  const isGlobalUnicast = hasPrefix(groups, GLOBAL_UNICAST);
  const isReservedInsideGlobalUnicast = NON_PUBLIC_INSIDE_GLOBAL_UNICAST.some((prefix) => hasPrefix(groups, prefix));
  return isGlobalUnicast && !isReservedInsideGlobalUnicast;
};

/**
 * True for an address a provider on the public internet answers at: an IPv4 address outside the special-purpose ranges (private, loopback, link-local, shared, documentation, benchmarking, multicast, reserved),
 * or an IPv6 global unicast address (2000::/3) outside its reserved parts (protocol assignments, documentation, 6to4). The IPv4-mapped and the well-known NAT64 forms are public when the IPv4 address they carry is;
 * every other IPv6 form, the IPv4-compatible and the local-use NAT64 ones included, is not. A text that is not an IP address, or that carries a zone, is not public.
 */
export const isPublicAddress = (address: string): boolean => {
  const version = isIP(address);
  const hasZone = address.includes('%');
  if (version === 0 || hasZone) return false;
  return version === 4 ? isPublicIpv4(address) : isPublicIpv6(address);
};
