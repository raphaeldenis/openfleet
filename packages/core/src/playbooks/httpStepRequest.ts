import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface HttpStepRequest {
  url: URL;
  method: string;
  /** Resolved headers; the caller has already refused line breaks. */
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** Exact host names the human approved in the policy; a host outside the list is never contacted. */
  allowedHosts: readonly string[];
  timeoutMs: number;
  /** The most characters of the response body kept in memory; the caller adds the length of its longest secret, so that a secret across the cap stays whole. */
  maxRetainedChars: number;
  /** Aborting destroys the connection. */
  signal: AbortSignal;
}

export type HttpStepOutcome =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'host_not_allowed' }
  | { kind: 'address_blocked' }
  | { kind: 'redirect_refused' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed' };

/** The seams of the network: tests replace them, the daemon uses the defaults. */
export interface HttpStepNetwork {
  /** Every address the name resolves to, in the order the system prefers. */
  resolveAddresses: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /** True for an address a host NAME may never resolve to. A literal address written in the allowed hosts is the human's choice and is not checked. */
  isForbiddenAddress: (address: string, family: 4 | 6) => boolean;
}

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

// Two lists: a BlockList reads an IPv4 address as an IPv6 one mapped in ::ffff:0:0/96, so one list for both would forbid every IPv4 address.
const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

export const REAL_HTTP_STEP_NETWORK: HttpStepNetwork = {
  resolveAddresses: async (hostname) => (await dnsLookup(hostname, { all: true })).map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 })),
  isForbiddenAddress: (address, family) => (family === 6 ? NON_PUBLIC_IPV6 : NON_PUBLIC_IPV4).check(address, family === 6 ? 'ipv6' : 'ipv4'),
};

type Pinned = { address: string; family: 4 | 6 };
type Pinning = { kind: 'pinned'; target: Pinned } | { kind: 'refused'; outcome: HttpStepOutcome };

const isLoopback = (address: string): boolean => LOOPBACK_ADDRESSES.check(address, address.includes(':') ? 'ipv6' : 'ipv4');

/** Chooses the one address the request connects to: a literal address as written, else the first answer of a single resolution, none of which may be forbidden. */
async function pinAddressOf(hostname: string, network: HttpStepNetwork): Promise<Pinning> {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) return { kind: 'pinned', target: { address: hostname, family: literalFamily === 6 ? 6 : 4 } };

  const answers = await network.resolveAddresses(hostname);
  const [first] = answers;
  if (first === undefined) return { kind: 'refused', outcome: { kind: 'failed' } };
  const isForbidden = answers.some(({ address, family }) => network.isForbiddenAddress(address, family));
  return isForbidden ? { kind: 'refused', outcome: { kind: 'address_blocked' } } : { kind: 'pinned', target: first };
}

/** The scheme `http` is reserved for a loopback address (a local fake server); every other host is reached over `https`. */
const schemeIsAcceptedFor = (url: URL, target: Pinned): boolean => url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(target.address));

const hostnameOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

/**
 * Sends one request and answers how it ended. It never throws and never carries the text of a system error, which can quote a header.
 * The host must be in the allowed list; its name is resolved once, the address is checked, and the connection goes to that very address
 * (no second resolution, so a DNS answer that changes between the check and the connection has no effect). TLS and the Host header keep the host name.
 * A redirect is never followed. The response body is kept up to `maxRetainedChars`; the rest is dropped and the connection is closed.
 */
export async function sendHttpStep(request: HttpStepRequest, network: HttpStepNetwork = REAL_HTTP_STEP_NETWORK): Promise<HttpStepOutcome> {
  const hostname = hostnameOf(request.url);
  const isHostAllowed = request.allowedHosts.includes(hostname);
  if (!isHostAllowed) return { kind: 'host_not_allowed' };

  let pinning: Pinning;
  try {
    pinning = await pinAddressOf(hostname, network);
  } catch {
    return { kind: 'failed' };
  }
  if (pinning.kind === 'refused') return pinning.outcome;
  const { target } = pinning;
  if (!schemeIsAcceptedFor(request.url, target)) return { kind: 'host_not_allowed' };
  if (request.signal.aborted) return { kind: 'aborted' };

  return new Promise<HttpStepOutcome>((resolve) => {
    let retained = '';
    let isFinished = false;
    const decoder = new StringDecoder('utf8');
    const send = request.url.protocol === 'https:' ? httpsRequest : httpRequest;

    const finish = (outcome: HttpStepOutcome): void => {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeoutTimer);
      request.signal.removeEventListener('abort', onAbort);
      outgoing.destroy();
      resolve(outcome);
    };
    const outgoing = send(request.url, {
      method: request.method,
      headers: request.headers,
      agent: false,
      lookup: (_name, options, callback) => {
        const answer = { address: target.address, family: target.family };
        if ((options as { all?: boolean }).all) (callback as (error: null, addresses: typeof answer[]) => void)(null, [answer]);
        else callback(null, answer.address, answer.family);
      },
    });
    const timeoutTimer = setTimeout(() => finish({ kind: 'timeout' }), request.timeoutMs);
    const onAbort = (): void => finish({ kind: 'aborted' });
    request.signal.addEventListener('abort', onAbort, { once: true });

    outgoing.on('error', () => finish({ kind: 'failed' }));
    outgoing.on('response', (response) => {
      const status = response.statusCode ?? 0;
      const isRedirect = status >= 300 && status < 400;
      if (isRedirect) return finish({ kind: 'redirect_refused' });

      const keep = (text: string): void => {
        const room = request.maxRetainedChars - retained.length;
        if (room > 0) retained += text.slice(0, room);
      };
      response.on('data', (chunk: Buffer) => {
        keep(decoder.write(chunk));
        const isFull = retained.length >= request.maxRetainedChars;
        if (isFull) finish({ kind: 'response', status, body: retained });
      });
      response.on('end', () => { keep(decoder.end()); finish({ kind: 'response', status, body: retained }); });
      response.on('error', () => finish({ kind: 'failed' }));
    });
    outgoing.end(request.body);
  });
}
