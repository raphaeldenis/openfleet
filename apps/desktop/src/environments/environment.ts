export const environment = {
  get apiUrl(): string {
    const storedApiUrl = globalThis.localStorage?.getItem('openfleet.apiUrl');
    if (!storedApiUrl) return 'http://127.0.0.1:7331';
    return storedApiUrl.trim().replace(/\/+$/, '');
  },
  get adminToken(): string {
    return globalThis.localStorage?.getItem('openfleet.adminToken') ?? '';
  },
  get daemonAddress(): string {
    return this.apiUrl.replace(/^\w+:\/\//, '');
  },
};
