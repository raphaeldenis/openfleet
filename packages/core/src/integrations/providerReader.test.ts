import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeHttpServer, type FakeHttpServer } from './fakeHttpServer.testkit.js';
import { createManualTimers, deferred, settle, until } from './manualTimers.testkit.js';
import { createPinnedProviderReader, type ProviderGet, type ResolvedAddress } from './providerReader.js';

const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const SMALL_BODY_LIMIT_BYTES = 1_024;
const SMALL_HEADER_LIMIT_BYTES = 8_192;
const CREDENTIAL_HEADER = 'Basic dGVzdDpjcmVkZW50aWFs';

let server: FakeHttpServer;
let bystander: FakeHttpServer;

beforeEach(async () => {
  server = await startFakeHttpServer();
  bystander = await startFakeHttpServer();
});
afterEach(async () => {
  await server.stop();
  await bystander.stop();
});

const A_DEADLINE_NOBODY_WAITS_FOR_MS = 5_000;

const readerOver = (resolve: (host: string) => Promise<ResolvedAddress> = async () => LOOPBACK, timers = createManualTimers()) =>
  createPinnedProviderReader({ resolve, startTimer: timers.startTimer, limits: { timeoutMs: A_DEADLINE_NOBODY_WAITS_FOR_MS, maxBodyBytes: SMALL_BODY_LIMIT_BYTES, maxHeaderBytes: SMALL_HEADER_LIMIT_BYTES } });

const abortListenersOf = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;

const getOf = (overrides: Partial<ProviderGet> = {}): ProviderGet => ({
  scheme: 'http', host: 'acme.atlassian.net', port: server.port, path: '/rest/api/3/search/jql?jql=x', headers: { authorization: CREDENTIAL_HEADER }, isAddressAllowed: () => true, ...overrides,
});

describe('reading a provider through a pinned address', () => {
  it('answers the parsed body and the etag of a 200, after sending only a GET with the given headers and no cookie', async () => {
    server.answerWith({ status: 200, headers: { etag: '"v1"', 'content-type': 'application/json' }, body: '{"issues":[]}' });

    const answer = await readerOver()(getOf());

    expect(answer).toEqual({ kind: 'ok', body: { issues: [] }, etag: '"v1"' });
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ method: 'GET', path: '/rest/api/3/search/jql?jql=x' });
    expect(server.seen[0]!.headers).toMatchObject({ authorization: CREDENTIAL_HEADER, host: `acme.atlassian.net:${server.port}`, 'accept-encoding': 'identity' });
    expect(server.seen[0]!.headers.cookie).toBeUndefined();
  });

  it.each([
    ['a strong etag', '"v1"'],
    ['a weak etag', 'W/"v1"'],
    ['an empty opaque tag', '""'],
    ['an etag of exactly the longest size', `"${'x'.repeat(254)}"`],
  ])('keeps %s', async (_label, etag) => {
    server.answerWith({ status: 200, headers: { etag }, body: '{}' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'ok', body: {}, etag });
  });

  it.each([
    ['an etag without quotes, which is how a credential would be echoed', 'canary-0000-1111'],
    ['an etag longer than the longest size', `"${'x'.repeat(255)}"`],
    ['an etag with a quote inside', '"a"b"'],
    ['an etag with only an opening quote', '"abc'],
    ['an etag with a space inside', '"a b"'],
    ['a weak marker without the quoted tag', 'W/abc'],
    ['an etag that is not a header value of reasonable size', 'x'.repeat(300)],
  ])('leaves out %s', async (_label, etag) => {
    server.answerWith({ status: 200, headers: { etag }, body: '{}' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'ok', body: {} });
  });

  it('answers not_modified to a 304', async () => {
    server.answerWith({ status: 304 });

    const answer = await readerOver()(getOf({ headers: { authorization: CREDENTIAL_HEADER, 'if-none-match': '"v1"' } }));

    expect(answer).toEqual({ kind: 'not_modified' });
    expect(server.seen[0]!.headers['if-none-match']).toBe('"v1"');
  });

  it.each([401, 403])('answers auth_failed to a %i', async (status) => {
    server.answerWith({ status, body: 'nope' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'auth_failed' });
  });

  it('answers rate_limited to a 429, with the whole seconds of Retry-After when the header is a plain integer', async () => {
    server.answerWith({ status: 429, headers: { 'retry-after': '120' } });
    const withHeader = await readerOver()(getOf());
    server.answerWith({ status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    const withDate = await readerOver()(getOf());

    expect(withHeader).toEqual({ kind: 'rate_limited', retryAfterSeconds: 120 });
    expect(withDate).toEqual({ kind: 'rate_limited' });
  });

  it.each([404, 500, 503])('answers unreachable to a %i and nothing of its body', async (status) => {
    server.answerWith({ status, body: `echo ${CREDENTIAL_HEADER}` });

    const answer = await readerOver()(getOf());

    expect(answer).toEqual({ kind: 'unreachable' });
  });

  it.each([301, 302, 307, 308])('refuses a %i redirect to another host: it is unreachable and the other host is never asked', async (status) => {
    server.answerWith({ status, headers: { location: `http://127.0.0.1:${bystander.port}/steal` }, body: '{"issues":[]}' });

    const answer = await readerOver()(getOf());

    expect(answer).toEqual({ kind: 'unreachable' });
    expect(bystander.seen).toEqual([]);
  });

  it.each([
    ['declares its size', (body: string) => ({ 'content-length': String(body.length) })],
    ['streams it', () => ({ 'transfer-encoding': 'chunked' })],
  ])('refuses a body larger than the limit when the server %s', async (_label, headersOf) => {
    const body = JSON.stringify({ filler: 'x'.repeat(SMALL_BODY_LIMIT_BYTES * 2) });
    server.answerWith({ status: 200, headers: headersOf(body), body });

    expect(await readerOver()(getOf())).toEqual({ kind: 'unreachable' });
  });

  it('accepts a body of exactly the limit', async () => {
    const body = JSON.stringify({ f: 'x'.repeat(SMALL_BODY_LIMIT_BYTES - '{"f":""}'.length) });
    expect(Buffer.byteLength(body)).toBe(SMALL_BODY_LIMIT_BYTES);
    server.answerWith({ status: 200, body });

    const answer = await readerOver()(getOf());

    expect(answer.kind).toBe('ok');
  });

  it('refuses response headers larger than the limit', async () => {
    server.answerWith({ status: 200, headers: { 'x-filler': 'a'.repeat(SMALL_HEADER_LIMIT_BYTES + 4_096) }, body: '{}' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'unreachable' });
  });

  it('refuses a body that is not JSON', async () => {
    server.answerWith({ status: 200, body: '<html>login</html>' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'unreachable' });
  });

  it('reads a 204 with no body as an answer without content', async () => {
    server.answerWith({ status: 204, body: '' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'ok', body: null });
  });

  it('gives up on a server that never answers, when the deadline elapses', async () => {
    server.answerWith({ status: 200, isSilent: true });
    const timers = createManualTimers();
    const pending = readerOver(undefined, timers)(getOf());
    await until(() => server.seen.length === 1);

    timers.elapseAll();

    expect(await pending).toEqual({ kind: 'unreachable' });
  });

  it('arms the deadline with the limit of the reader', async () => {
    const timers = createManualTimers();

    await readerOver(undefined, timers)(getOf());

    expect(timers.delaysArmed()).toEqual([A_DEADLINE_NOBODY_WAITS_FOR_MS]);
  });

  it('cancels its deadline once it has answered', async () => {
    const timers = createManualTimers();

    await readerOver(undefined, timers)(getOf());

    expect(timers.cancelledCount()).toBe(1);
  });

  it('answers unreachable when the host cannot be resolved, and asks nobody', async () => {
    const answer = await readerOver(async () => { throw new Error('ENOTFOUND'); })(getOf());

    expect(answer).toEqual({ kind: 'unreachable' });
    expect(server.seen).toEqual([]);
  });
});

describe('the address a request is pinned to', () => {
  it('resolves the host once and connects to that very address, even when a second resolution would answer differently', async () => {
    const resolutions: string[] = [];
    const rebindingResolver = async (host: string): Promise<ResolvedAddress> => {
      resolutions.push(host);
      return resolutions.length === 1 ? LOOPBACK : { address: '203.0.113.9', family: 4 };
    };

    const answer = await readerOver(rebindingResolver)(getOf());

    expect(answer.kind).toBe('ok');
    expect(resolutions).toEqual(['acme.atlassian.net']);
    expect(server.seen).toHaveLength(1);
  });

  it('refuses an address the provider does not allow, and connects to nobody', async () => {
    const answer = await readerOver()(getOf({ isAddressAllowed: (address) => address !== '127.0.0.1' }));

    expect(answer).toEqual({ kind: 'unreachable' });
    expect(server.seen).toEqual([]);
  });

  it('asks the policy about the resolved address, not about the host name', async () => {
    const asked: string[] = [];

    await readerOver()(getOf({ isAddressAllowed: (address) => { asked.push(address); return true; } }));

    expect(asked).toEqual(['127.0.0.1']);
  });
});

describe('a name that is still being resolved', () => {
  const heldResolver = () => {
    const lookups: string[] = [];
    const answer = deferred<ResolvedAddress>();
    return { resolve: (host: string) => { lookups.push(host); return answer.promise; }, lookups, release: (address: ResolvedAddress) => answer.resolve(address) };
  };

  it('arms the deadline before it asks the resolver, so that the resolution is inside it', async () => {
    const timers = createManualTimers();
    const events: string[] = [];
    const watchedTimers = { ...timers, startTimer: (onElapsed: () => void, delayMs: number) => { events.push('deadline armed'); return timers.startTimer(onElapsed, delayMs); } };
    const reader = readerOver(async () => { events.push('resolver asked'); return LOOPBACK; }, watchedTimers);

    await reader(getOf());

    expect(events).toEqual(['deadline armed', 'resolver asked']);
  });

  it('answers unreachable when the deadline elapses during the resolution, and asks nobody', async () => {
    const timers = createManualTimers();
    const resolver = heldResolver();
    const pending = readerOver(resolver.resolve, timers)(getOf());

    timers.elapseAll();

    expect(await pending).toEqual({ kind: 'unreachable' });
    expect(server.seen).toEqual([]);
  });

  it('opens no connection when the resolver answers after the deadline', async () => {
    const timers = createManualTimers();
    const resolver = heldResolver();
    const pending = readerOver(resolver.resolve, timers)(getOf());
    timers.elapseAll();
    await pending;

    resolver.release(LOOPBACK);
    await settle();

    expect(server.seen).toEqual([]);
  });

  it('does not ask the address policy about an answer that comes after the deadline', async () => {
    const timers = createManualTimers();
    const resolver = heldResolver();
    const asked: string[] = [];
    const pending = readerOver(resolver.resolve, timers)(getOf({ isAddressAllowed: (address) => { asked.push(address); return true; } }));
    timers.elapseAll();
    await pending;

    resolver.release(LOOPBACK);
    await settle();

    expect(asked).toEqual([]);
  });

  it('answers unreachable as soon as the signal aborts, cancels its deadline and drops its abort listener', async () => {
    const timers = createManualTimers();
    const resolver = heldResolver();
    const controller = new AbortController();
    const pending = readerOver(resolver.resolve, timers)(getOf({ signal: controller.signal }));
    await until(() => resolver.lookups.length === 1);
    expect(abortListenersOf(controller.signal)).toBe(1);

    controller.abort();

    expect(await pending).toEqual({ kind: 'unreachable' });
    expect(timers.cancelledCount()).toBe(1);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('opens no connection when the resolver answers after the abort', async () => {
    const resolver = heldResolver();
    const controller = new AbortController();
    const pending = readerOver(resolver.resolve)(getOf({ signal: controller.signal }));
    controller.abort();
    await pending;

    resolver.release(LOOPBACK);
    await settle();

    expect(server.seen).toEqual([]);
  });

  it('answers unreachable for a signal already aborted, without asking the resolver or arming a deadline', async () => {
    const timers = createManualTimers();
    const resolver = heldResolver();
    const controller = new AbortController();
    controller.abort();

    const answer = await readerOver(resolver.resolve, timers)(getOf({ signal: controller.signal }));

    expect(answer).toEqual({ kind: 'unreachable' });
    expect(resolver.lookups).toEqual([]);
    expect(timers.armedCount()).toBe(0);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('aborts a request that is already on the wire', async () => {
    server.answerWith({ status: 200, isSilent: true });
    const controller = new AbortController();
    const pending = readerOver()(getOf({ signal: controller.signal }));
    await until(() => server.seen.length === 1);

    controller.abort();

    expect(await pending).toEqual({ kind: 'unreachable' });
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('drops its abort listener once it has answered', async () => {
    const controller = new AbortController();

    await readerOver()(getOf({ signal: controller.signal }));

    expect(abortListenersOf(controller.signal)).toBe(0);
  });
});
