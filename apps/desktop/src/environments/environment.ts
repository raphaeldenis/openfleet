const DEFAULT_API_URL = 'http://127.0.0.1:7331';

function normalizeStoredApiUrl(rawApiUrl: string): string | null {
  const trimmedApiUrl = rawApiUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmedApiUrl) ? trimmedApiUrl : null;
}

export const environment = {
  get apiUrl(): string {
    const storedApiUrl = globalThis.localStorage?.getItem('openfleet.apiUrl');
    if (!storedApiUrl) return DEFAULT_API_URL;
    return normalizeStoredApiUrl(storedApiUrl) ?? DEFAULT_API_URL;
  },
  get adminToken(): string {
    return globalThis.localStorage?.getItem('openfleet.adminToken') ?? '';
  },
  get daemonAddress(): string {
    return this.apiUrl.replace(/^\w+:\/\//, '');
  },
};
