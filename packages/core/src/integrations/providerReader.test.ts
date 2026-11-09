import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeHttpServer, type FakeHttpServer } from './fakeHttpServer.testkit.js';
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

const readerOver = (resolve: (host: string) => Promise<ResolvedAddress> = async () => LOOPBACK, limits: { timeoutMs?: number } = {}) =>
  createPinnedProviderReader({ resolve, limits: { timeoutMs: limits.timeoutMs ?? 5_000, maxBodyBytes: SMALL_BODY_LIMIT_BYTES, maxHeaderBytes: SMALL_HEADER_LIMIT_BYTES } });

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

  it('leaves out an etag that is not a printable header value of reasonable size', async () => {
    server.answerWith({ status: 200, headers: { etag: 'x'.repeat(300) }, body: '{}' });

    const answer = await readerOver()(getOf());

    expect(answer).toEqual({ kind: 'ok', body: {} });
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
    server.answerWith({ status, headers: { location: `http://127.0.0.1:${bystander.port}/steal` } });

    const answer = await readerOver()(getOf());

    expect(answer).toEqual({ kind: 'unreachable' });
    expect(bystander.seen).toEqual([]);
  });

  it('refuses a body larger than the limit, whether the server declares its size or streams it', async () => {
    const oversized = 'x'.repeat(SMALL_BODY_LIMIT_BYTES * 2);
    server.answerWith({ status: 200, headers: { 'content-length': String(oversized.length) }, body: JSON.stringify({ filler: oversized }) });
    const declared = await readerOver()(getOf());
    server.answerWith({ status: 200, headers: { 'transfer-encoding': 'chunked' }, body: JSON.stringify({ filler: oversized }) });
    const streamed = await readerOver()(getOf());

    expect(declared).toEqual({ kind: 'unreachable' });
    expect(streamed).toEqual({ kind: 'unreachable' });
  });

  it('accepts a body of exactly the limit', async () => {
    const body = JSON.stringify({ f: 'x'.repeat(SMALL_BODY_LIMIT_BYTES - '{"f":""}'.length) });
    expect(Buffer.byteLength(body)).toBe(SMALL_BODY_LIMIT_BYTES);
    server.answerWith({ status: 200, body });

    const answer = await readerOver()(getOf());

    expect(answer.kind).toBe('ok');
  });

  it('refuses response headers larger than the limit', async () => {
    server.answerWith({ status: 200, headers: { 'x-filler': 'a'.repeat(SMALL_HEADER_LIMIT_BYTES * 2) }, body: '{}' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'unreachable' });
  });

  it('refuses a body that is not JSON', async () => {
    server.answerWith({ status: 200, body: '<html>login</html>' });

    expect(await readerOver()(getOf())).toEqual({ kind: 'unreachable' });
  });

  it('gives up on a server that never answers', async () => {
    server.answerWith({ status: 200, isSilent: true });

    expect(await readerOver(undefined, { timeoutMs: 50 })(getOf())).toEqual({ kind: 'unreachable' });
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
