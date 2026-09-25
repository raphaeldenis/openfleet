export const environment = {
  get apiUrl(): string {
    return globalThis.localStorage?.getItem('openfleet.apiUrl') ?? 'http://127.0.0.1:7331';
  },
  get adminToken(): string {
    return globalThis.localStorage?.getItem('openfleet.adminToken') ?? '';
  },
};
