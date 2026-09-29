import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';
import { FleetEventsService } from './fleet-events.service';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7331';
const FAKE_TICKET = 'fake-ticket';
const DEFAULT_SOCKET_URL = `ws://127.0.0.1:7331/ws?ticket=${FAKE_TICKET}`;
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

// Every rejected value sits on port 9999, never the default 7331: a wrongly accepted value would then
// yield a URL different from the default one, instead of hiding behind an identical fallback.
const rejectedStoredApiUrls = [
  ['credentials in front of a loopback host', 'http://user:pass@127.0.0.1:9999'],
  ['empty credentials in front of a loopback host', 'http://:@127.0.0.1:9999'],
  ['a query on a loopback host', 'http://127.0.0.1:9999?x=1'],
  ['a query after a slash on a loopback host', 'http://localhost:9999/?x=1'],
  ['an empty query on a loopback host', 'http://127.0.0.1:9999/?'],
  ['a fragment on a loopback host', 'http://127.0.0.1:9999#frag'],
  ['an empty fragment on a loopback host', 'http://127.0.0.1:9999/#'],
  ['the ftp scheme on a loopback host', 'ftp://127.0.0.1:9999'],
  ['the ws scheme on a loopback host', 'ws://127.0.0.1:9999'],
  ['the wss scheme on localhost', 'wss://localhost:9999'],
  ['the file scheme on localhost', 'file://localhost/etc/passwd'],
  ['a subdomain of localhost', 'http://foo.localhost:9999'],
  ['a host that only ends with localhost', 'http://notlocalhost:9999'],
  ['localhost with a trailing dot', 'http://localhost.:9999'],
  ['a loopback address followed by a remote domain', 'http://127.0.0.1.evil.com:9999'],
  ['an address that only starts with 127.0.0.1', 'http://127.0.0.10:9999'],
  ['a global IPv6 address ending in ::1', 'http://[2001:db8::1]:9999'],
  ['another address next to the IPv6 loopback', 'http://[::2]:9999'],
  ['the IPv4-mapped IPv6 loopback in dotted form', 'http://[::ffff:127.0.0.1]:9999'],
  ['an IPv6 loopback with a zone id', 'http://[::1%25en0]:9999'],
  ['a remote host in front of a backslash and a loopback address', 'http://evil.com\\127.0.0.1:9999'],
  ['a whitespace inside the host', 'http://local\t host:9999'],
  ['an ideographic dot in a remote host', 'http://evil。com:9999'],
] as const;

const canonicalLoopbackStoredApiUrls = [
  ['a shorthand IPv4 loopback', 'http://127.1:9999', 'http://127.0.0.1:9999'],
  ['a decimal IPv4 loopback', 'http://2130706433:9999', 'http://127.0.0.1:9999'],
  ['an IPv4 loopback written with ideographic dots', 'http://127。0。0。1:9999', 'http://127.0.0.1:9999'],
  ['an expanded IPv6 loopback', 'http://[0:0:0:0:0:0:0:1]:9999', 'http://[::1]:9999'],
  ['a percent-encoded localhost', 'http://%6c%6f%63%61%6c%68%6f%73%74:9999', 'http://localhost:9999'],
] as const;

const pathTrickStoredApiUrls = [
  'http://localhost:9999//evil.com',
  'http://localhost:9999\\evil.com',
  'http://localhost:9999/%40evil.com',
  'http://localhost:9999/..//evil.com',
  'http://localhost:9999/x/../../evil.com/',
];

describe('where the admin token goes, whatever is stored as the daemon address', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let socketUrls: string[];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('openfleet.adminToken', 'secret-token');
    // The ws-ticket call gets a ticket back; every other REST call keeps the old generic empty-body mock.
    fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/api/ws-ticket')
          ? { ok: true, status: 200, json: () => Promise.resolve({ ticket: FAKE_TICKET }) }
          : { ok: true, status: 200, json: () => Promise.resolve({}) },
      ),
    );
    socketUrls = [];
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'WebSocket',
      class {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        readyState = 0;
        constructor(url: string) {
          socketUrls.push(url);
        }
        addEventListener(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function requestedRestUrl(storedApiUrl: string): Promise<string> {
    localStorage.setItem('openfleet.apiUrl', storedApiUrl);
    fetchMock.mockClear();
    await new FleetApiService().closeSession('s1');
    const [requestedUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    return requestedUrl;
  }

  async function openedSocketUrl(storedApiUrl: string): Promise<string> {
    localStorage.setItem('openfleet.apiUrl', storedApiUrl);
    await new FleetEventsService().connect();
    return socketUrls.at(-1)!;
  }

  it.each(rejectedStoredApiUrls)('sends both the request and the socket to the default daemon for %s (%s)', async (_label, storedApiUrl) => {
    const restUrl = await requestedRestUrl(storedApiUrl);
    const socketUrl = await openedSocketUrl(storedApiUrl);

    expect(restUrl).toBe(`${DEFAULT_DAEMON_URL}/api/sessions/s1/close`);
    expect(socketUrl).toBe(DEFAULT_SOCKET_URL);
  });

  it.each(canonicalLoopbackStoredApiUrls)('keeps %s on its canonical loopback form (%s)', async (_label, storedApiUrl, canonicalDaemonUrl) => {
    const restUrl = await requestedRestUrl(storedApiUrl);
    const socketUrl = await openedSocketUrl(storedApiUrl);

    expect(restUrl).toBe(`${canonicalDaemonUrl}/api/sessions/s1/close`);
    expect(socketUrl).toBe(`${canonicalDaemonUrl.replace(/^http/, 'ws')}/ws?ticket=${FAKE_TICKET}`);
  });

  const everyStoredApiUrl = [
    ...rejectedStoredApiUrls.map(([, storedApiUrl]) => storedApiUrl),
    ...canonicalLoopbackStoredApiUrls.map(([, storedApiUrl]) => storedApiUrl),
    ...pathTrickStoredApiUrls,
  ];

  it.each(everyStoredApiUrl)('never aims the request or the socket at a non-loopback host or at credentials: %s', async (storedApiUrl) => {
    const restUrl = new URL(await requestedRestUrl(storedApiUrl));
    const socketUrl = new URL(await openedSocketUrl(storedApiUrl));

    for (const destination of [restUrl, socketUrl]) {
      expect(LOOPBACK_HOSTNAMES).toContain(destination.hostname);
      expect(destination.username).toBe('');
      expect(destination.password).toBe('');
    }
  });

  // AUD-27: the admin token used to travel in the WS URL itself and land in the console on every failed
  // reconnect. It no longer appears there at all — only a short-lived ticket does.
  it.each(everyStoredApiUrl)('never puts the admin token anywhere in the WS URL: %s', async (storedApiUrl) => {
    const socketUrl = await openedSocketUrl(storedApiUrl);

    expect(socketUrl).not.toContain('secret-token');
  });
});
