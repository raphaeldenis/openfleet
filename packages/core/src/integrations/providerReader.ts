import { lookup as lookupWithDns } from 'node:dns/promises';
import { request as requestOverHttp, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as requestOverHttps } from 'node:https';
import type { LookupFunction } from 'node:net';

export interface ResolvedAddress { address: string; family: 4 | 6 }

/** One read of a provider: a GET and nothing else. The caller names the host, the path with its query and the headers; the credential travels in `headers` and is never echoed back. */
export interface ProviderGet {
  scheme: 'https' | 'http';
  host: string;
  port?: number;
  path: string;
  headers: Record<string, string>;
  isAddressAllowed: (address: string) => boolean;
}

/** What a read ends with: a type, plus the parsed body of a 200. No error text, no header, no byte of a refused answer leaves the reader. */
export type ProviderAnswer =
  | { kind: 'ok'; body: unknown; etag?: string }
  | { kind: 'not_modified' }
  | { kind: 'auth_failed' }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  | { kind: 'unreachable' };

export type ProviderReader = (get: ProviderGet) => Promise<ProviderAnswer>;

export interface ProviderReaderLimits { timeoutMs: number; maxBodyBytes: number; maxHeaderBytes: number }

export const DEFAULT_PROVIDER_READER_LIMITS: ProviderReaderLimits = { timeoutMs: 15_000, maxBodyBytes: 1_048_576, maxHeaderBytes: 16_384 };

const UNREACHABLE: ProviderAnswer = { kind: 'unreachable' };
const AUTH_REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const RATE_LIMITED_STATUS = 429;
const NOT_MODIFIED_STATUS = 304;
const MAX_ETAG_CHARS = 256;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const WHOLE_SECONDS = /^\d{1,6}$/;

const resolveWithDns = async (host: string): Promise<ResolvedAddress> => {
  const { address, family } = await lookupWithDns(host);
  return { address, family: family === 6 ? 6 : 4 };
};

const resolvedOrUndefined = async (resolve: (host: string) => Promise<ResolvedAddress>, host: string): Promise<ResolvedAddress | undefined> => {
  try {
    return await resolve(host);
  } catch {
    return undefined;
  }
};

/** A lookup that answers the address already validated, whatever the name: the connection cannot land elsewhere than where the policy looked. */
const lookupPinnedTo = ({ address, family }: ResolvedAddress): LookupFunction => (_host, options, callback) => {
  if (options.all === true) return (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(null, [{ address, family }]);
  callback(null, address, family);
};

const etagOf = (response: IncomingMessage): string | undefined => {
  const etag = response.headers.etag;
  const isUsable = typeof etag === 'string' && etag.length <= MAX_ETAG_CHARS && PRINTABLE_ASCII.test(etag);
  return isUsable ? etag : undefined;
};

const retryAfterSecondsOf = (response: IncomingMessage): number | undefined => {
  const retryAfter = response.headers['retry-after'];
  const isWholeSeconds = typeof retryAfter === 'string' && WHOLE_SECONDS.test(retryAfter);
  return isWholeSeconds ? Number(retryAfter) : undefined;
};

const parsedOrUndefined = (text: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

const readOnce = (get: ProviderGet, pinned: ResolvedAddress, limits: ProviderReaderLimits): Promise<ProviderAnswer> =>
  new Promise((resolveAnswer) => {
    const options: RequestOptions = {
      host: get.host, ...(get.port !== undefined && { port: get.port }), path: get.path, method: 'GET', agent: false,
      headers: { ...get.headers, accept: 'application/json', 'accept-encoding': 'identity' },
      lookup: lookupPinnedTo(pinned), maxHeaderSize: limits.maxHeaderBytes, signal: AbortSignal.timeout(limits.timeoutMs),
    };
    const request = (get.scheme === 'https' ? requestOverHttps : requestOverHttp)(options);
    const finish = (answer: ProviderAnswer): void => { resolveAnswer(answer); request.destroy(); };

    request.on('error', () => finish(UNREACHABLE));
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status === NOT_MODIFIED_STATUS) return finish({ kind: 'not_modified' });
      if (AUTH_REFUSED_STATUSES.has(status)) return finish({ kind: 'auth_failed' });
      if (status === RATE_LIMITED_STATUS) {
        const retryAfterSeconds = retryAfterSecondsOf(response);
        return finish({ kind: 'rate_limited', ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) });
      }
      const isSuccess = status >= 200 && status < 300;
      if (!isSuccess) return finish(UNREACHABLE);

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        const hasExceededTheLimit = receivedBytes > limits.maxBodyBytes;
        if (hasExceededTheLimit) return finish(UNREACHABLE);
        chunks.push(chunk);
      });
      response.on('error', () => finish(UNREACHABLE));
      response.on('end', () => {
        const parsed = parsedOrUndefined(Buffer.concat(chunks).toString('utf8'));
        if (parsed === undefined) return finish(UNREACHABLE);
        const etag = etagOf(response);
        finish({ kind: 'ok', body: parsed.value, ...(etag !== undefined && { etag }) });
      });
    });
    request.end();
  });

/**
 * Reads a provider with a GET. The host is resolved once, the address is checked by the provider's own policy, and the connection is made to that address:
 * a second resolution that answers differently (DNS rebinding) changes nothing. A redirect is never followed, a body or a header over its limit is refused,
 * and every failure reads as `unreachable`.
 */
export const createPinnedProviderReader = ({ resolve = resolveWithDns, limits = DEFAULT_PROVIDER_READER_LIMITS }: { resolve?: (host: string) => Promise<ResolvedAddress>; limits?: ProviderReaderLimits } = {}): ProviderReader =>
  async (get) => {
    const pinned = await resolvedOrUndefined(resolve, get.host);
    if (pinned === undefined) return UNREACHABLE;
    const isAddressAllowed = get.isAddressAllowed(pinned.address);
    if (!isAddressAllowed) return UNREACHABLE;
    return readOnce(get, pinned, limits);
  };
