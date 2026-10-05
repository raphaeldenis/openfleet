import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptDaemonUrlFromQuery } from '../../environments/environment';
import { setAdminToken } from './admin-token.store';
import { FleetApiService } from './fleet-api.service';
import { FleetEventsService } from './fleet-events.service';

const ADMIN_TOKEN = 'secret-token';
const ORIGINAL_DAEMON = 'http://127.0.0.1:7500';
const OTHER_DAEMON = 'http://127.0.0.1:7600';
const DEFAULT_DAEMON = 'http://127.0.0.1:7331';
const daemonQuery = (daemonUrl: string) => `?daemon=${encodeURIComponent(daemonUrl)}`;

interface RecordedRequest { url: string; authorization: string | undefined }

describe('the admin token only travels to the daemon it was issued for', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let confirmMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    setAdminToken('');
    fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(String(url).endsWith('/api/ws-ticket') ? { ticket: 't' } : {}) }),
    );
    confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', confirmMock);
    vi.stubGlobal('WebSocket', class { static readonly CONNECTING = 0; static readonly OPEN = 1; readyState = 0; addEventListener(): void {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAdminToken('');
    localStorage.clear();
  });

  function signInAt(daemonUrl: string): void {
    localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
    localStorage.setItem('openfleet.apiUrl', daemonUrl);
  }

  async function nextRestRequest(): Promise<RecordedRequest> {
    fetchMock.mockClear();
    await new FleetApiService().closeSession('s1');
    return lastRequest();
  }

  async function nextTicketRequest(): Promise<RecordedRequest> {
    fetchMock.mockClear();
    await new FleetEventsService().connect();
    return lastRequest();
  }

  function lastRequest(): RecordedRequest {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    return { url, authorization: headers['authorization'] };
  }

  const carriesToken = ({ authorization }: RecordedRequest) => (authorization ?? '').includes(ADMIN_TOKEN);

  it('sends the token to the daemon it was first used with', async () => {
    signInAt(ORIGINAL_DAEMON);

    const request = await nextRestRequest();

    expect(request.url.startsWith(ORIGINAL_DAEMON)).toBe(true);
    expect(carriesToken(request)).toBe(true);
  });

  it('withholds the token from a daemon the stored address is switched to, on REST calls and on socket tickets', async () => {
    signInAt(ORIGINAL_DAEMON);
    await nextRestRequest();

    localStorage.setItem('openfleet.apiUrl', OTHER_DAEMON);
    const restRequest = await nextRestRequest();
    const ticketRequest = await nextTicketRequest();

    expect(restRequest.url.startsWith(OTHER_DAEMON)).toBe(true);
    expect(carriesToken(restRequest)).toBe(false);
    expect(ticketRequest.url.startsWith(OTHER_DAEMON)).toBe(true);
    expect(carriesToken(ticketRequest)).toBe(false);
  });

  it('sends the token again once the stored address returns to the original daemon', async () => {
    signInAt(ORIGINAL_DAEMON);
    await nextRestRequest();
    localStorage.setItem('openfleet.apiUrl', OTHER_DAEMON);
    await nextRestRequest();

    localStorage.setItem('openfleet.apiUrl', ORIGINAL_DAEMON);
    const request = await nextRestRequest();

    expect(carriesToken(request)).toBe(true);
  });

  describe('when a link names another daemon with ?daemon=', () => {
    it('asks the user to confirm and names the daemon', () => {
      signInAt(ORIGINAL_DAEMON);

      adoptDaemonUrlFromQuery(daemonQuery(OTHER_DAEMON));

      expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock.mock.calls[0]![0]).toContain(OTHER_DAEMON);
    });

    it('keeps talking to the original daemon, token included, when the user declines', async () => {
      signInAt(ORIGINAL_DAEMON);
      confirmMock.mockReturnValue(false);

      adoptDaemonUrlFromQuery(daemonQuery(OTHER_DAEMON));
      const request = await nextRestRequest();

      expect(request.url.startsWith(ORIGINAL_DAEMON)).toBe(true);
      expect(carriesToken(request)).toBe(true);
    });

    it('does not switch the stored daemon while the user is still being asked', () => {
      signInAt(ORIGINAL_DAEMON);
      let storedDaemonWhileAsking: string | null = null;
      confirmMock.mockImplementation(() => {
        storedDaemonWhileAsking = localStorage.getItem('openfleet.apiUrl');
        return false;
      });

      adoptDaemonUrlFromQuery(daemonQuery(OTHER_DAEMON));

      expect(storedDaemonWhileAsking).toBe(ORIGINAL_DAEMON);
    });

    it('sends the token to the named daemon, and only to it, once the user confirms', async () => {
      signInAt(ORIGINAL_DAEMON);
      confirmMock.mockReturnValue(true);

      adoptDaemonUrlFromQuery(daemonQuery(OTHER_DAEMON));
      const requestToNamedDaemon = await nextRestRequest();
      localStorage.setItem('openfleet.apiUrl', ORIGINAL_DAEMON);
      const requestToOriginalDaemon = await nextRestRequest();

      expect(requestToNamedDaemon.url.startsWith(OTHER_DAEMON)).toBe(true);
      expect(carriesToken(requestToNamedDaemon)).toBe(true);
      expect(carriesToken(requestToOriginalDaemon)).toBe(false);
    });

    it('does not ask when the link names the daemon the app already talks to', () => {
      signInAt(ORIGINAL_DAEMON);

      adoptDaemonUrlFromQuery(daemonQuery(ORIGINAL_DAEMON));

      expect(confirmMock).not.toHaveBeenCalled();
    });

    it('protects a token that was stored for the default daemon before any request was made', async () => {
      localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
      confirmMock.mockReturnValue(false);

      adoptDaemonUrlFromQuery(daemonQuery(OTHER_DAEMON));
      const request = await nextRestRequest();

      expect(request.url.startsWith(DEFAULT_DAEMON)).toBe(true);
      expect(carriesToken(request)).toBe(true);
    });
  });

  describe('for the token the desktop shell reads in memory', () => {
    it('sends it to the default daemon', async () => {
      setAdminToken(ADMIN_TOKEN);

      const request = await nextRestRequest();

      expect(request.url.startsWith(DEFAULT_DAEMON)).toBe(true);
      expect(carriesToken(request)).toBe(true);
    });

    it('ignores ?daemon= without asking anything: the desktop shell keeps its own daemon', async () => {
      vi.stubGlobal('__TAURI_INTERNALS__', {});
      setAdminToken(ADMIN_TOKEN);

      adoptDaemonUrlFromQuery(daemonQuery(OTHER_DAEMON));
      const request = await nextRestRequest();

      expect(confirmMock).not.toHaveBeenCalled();
      expect(request.url.startsWith(DEFAULT_DAEMON)).toBe(true);
      expect(carriesToken(request)).toBe(true);
    });

    it('withholds it from any other daemon', async () => {
      setAdminToken(ADMIN_TOKEN);
      localStorage.setItem('openfleet.apiUrl', OTHER_DAEMON);

      const request = await nextRestRequest();

      expect(request.url.startsWith(OTHER_DAEMON)).toBe(true);
      expect(carriesToken(request)).toBe(false);
    });
  });
});
