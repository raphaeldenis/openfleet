const DEFAULT_API_URL = 'http://127.0.0.1:7331';
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function normalizeStoredApiUrl(rawApiUrl: string): string | null {
  const trimmedApiUrl = rawApiUrl.trim();
  const hasUserinfoQueryOrFragment = /[@?#]/.test(trimmedApiUrl);
  if (hasUserinfoQueryOrFragment) return null;

  const url = parseUrl(trimmedApiUrl);
  if (!url) return null;
  const isHttp = HTTP_PROTOCOLS.has(url.protocol);
  const isLoopbackDaemon = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!isHttp || !isLoopbackDaemon) return null;

  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathWithoutTrailingSlash}`;
}

export const environment = {
  get apiUrl(): string {
    const storedApiUrl = globalThis.localStorage?.getItem('openfleet.apiUrl');
    if (!storedApiUrl) return DEFAULT_API_URL;
    return normalizeStoredApiUrl(storedApiUrl) ?? DEFAULT_API_URL;
  },
  get adminToken(): string {
    return globalThis.localStorage?.getItem('openfleet.adminToken')?.trim() ?? '';
  },
  get daemonAddress(): string {
    return this.apiUrl.replace(/^\w+:\/\//, '');
  },
};
