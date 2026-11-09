import { lookup as lookupWithDns } from 'node:dns/promises';
import { request as requestOverHttp, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
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
  /** Aborting ends the read at once, whether the name is still being resolved or the request is on the wire. */
  signal?: AbortSignal;
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

/** Calls `onElapsed` once after `delayMs` and returns the function that cancels it; tests inject timers they drive by hand. */
export type StartTimer = (onElapsed: () => void, delayMs: number) => () => void;

const UNREACHABLE: ProviderAnswer = { kind: 'unreachable' };
const AUTH_REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const RATE_LIMITED_STATUS = 429;
const NOT_MODIFIED_STATUS = 304;
const MAX_ETAG_CHARS = 256;
/** An entity tag: an optional weak marker, then a quoted run of printable ASCII without a quote or a space. */
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]*"$/;
const WHOLE_SECONDS = /^\d{1,6}$/;

const resolveWithDns = async (host: string): Promise<ResolvedAddress> => {
  const { address, family } = await lookupWithDns(host);
  return { address, family: family === 6 ? 6 : 4 };
};

const startRealTimer: StartTimer = (onElapsed, delayMs) => {
  const timer = setTimeout(onElapsed, delayMs);
  return () => clearTimeout(timer);
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
  const isUsable = typeof etag === 'string' && etag.length <= MAX_ETAG_CHARS && ENTITY_TAG.test(etag);
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

/** Sends the GET to the pinned address and calls `settle` once, with how the answer ended. */
const sendTo = ({ get, pinned, limits, settle }: { get: ProviderGet; pinned: ResolvedAddress; limits: ProviderReaderLimits; settle: (answer: ProviderAnswer) => void }): ClientRequest => {
  const options: RequestOptions = {
    host: get.host, ...(get.port !== undefined && { port: get.port }), path: get.path, method: 'GET', agent: false,
    headers: { ...get.headers, accept: 'application/json', 'accept-encoding': 'identity' },
    lookup: lookupPinnedTo(pinned), maxHeaderSize: limits.maxHeaderBytes,
  };
  const request = (get.scheme === 'https' ? requestOverHttps : requestOverHttp)(options);

  request.on('error', () => settle(UNREACHABLE));
  request.on('response', (response) => {
    const status = response.statusCode ?? 0;
    if (status === NOT_MODIFIED_STATUS) return settle({ kind: 'not_modified' });
    if (AUTH_REFUSED_STATUSES.has(status)) return settle({ kind: 'auth_failed' });
    if (status === RATE_LIMITED_STATUS) {
      const retryAfterSeconds = retryAfterSecondsOf(response);
      return settle({ kind: 'rate_limited', ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) });
    }
    const isSuccess = status >= 200 && status < 300;
    if (!isSuccess) return settle(UNREACHABLE);

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    response.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      const hasExceededTheLimit = receivedBytes > limits.maxBodyBytes;
      if (hasExceededTheLimit) return settle(UNREACHABLE);
      chunks.push(chunk);
    });
    response.on('error', () => settle(UNREACHABLE));
    response.on('end', () => {
      const parsed = parsedOrUndefined(Buffer.concat(chunks).toString('utf8'));
      if (parsed === undefined) return settle(UNREACHABLE);
      const etag = etagOf(response);
      settle({ kind: 'ok', body: parsed.value, ...(etag !== undefined && { etag }) });
    });
  });
  request.end();
  return request;
};

export interface PinnedProviderReaderOptions {
  resolve?: (host: string) => Promise<ResolvedAddress>;
  limits?: ProviderReaderLimits;
  startTimer?: StartTimer;
}

/**
 * Reads a provider with a GET. The host is resolved once, the address is checked by the provider's own policy, and the connection is made to that address:
 * a second resolution that answers differently (DNS rebinding) changes nothing. A redirect is never followed, a body or a header over its limit is refused,
 * and every failure reads as `unreachable`.
 * The deadline and the abort signal are armed before the resolution and cover it as much as the transport: a name that never resolves ends at the deadline,
 * and an answer of the resolver that comes after the read ended opens no connection.
 */
export const createPinnedProviderReader = ({ resolve = resolveWithDns, limits = DEFAULT_PROVIDER_READER_LIMITS, startTimer = startRealTimer }: PinnedProviderReaderOptions = {}): ProviderReader =>
  (get) => new Promise<ProviderAnswer>((resolveAnswer) => {
    let isFinished = false;
    let outgoing: ClientRequest | undefined;

    const finish = (answer: ProviderAnswer): void => {
      if (isFinished) return;
      isFinished = true;
      cancelDeadline();
      get.signal?.removeEventListener('abort', onAbort);
      outgoing?.destroy();
      resolveAnswer(answer);
    };
    const onAbort = (): void => finish(UNREACHABLE);

    const isAlreadyAborted = get.signal?.aborted === true;
    if (isAlreadyAborted) return resolveAnswer(UNREACHABLE);

    const cancelDeadline = startTimer(() => finish(UNREACHABLE), limits.timeoutMs);
    get.signal?.addEventListener('abort', onAbort, { once: true });

    void resolvedOrUndefined(resolve, get.host).then((pinned) => {
      const hasEndedMeanwhile = isFinished;
      if (hasEndedMeanwhile) return;
      if (pinned === undefined) return finish(UNREACHABLE);
      const isAddressAllowed = get.isAddressAllowed(pinned.address);
      if (!isAddressAllowed) return finish(UNREACHABLE);
      outgoing = sendTo({ get, pinned, limits, settle: finish });
    }).catch(() => finish(UNREACHABLE));
  });
