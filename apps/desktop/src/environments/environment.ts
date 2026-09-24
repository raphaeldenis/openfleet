export const environment = {
  apiUrl: 'http://127.0.0.1:7331',
  adminToken: (globalThis as { OPENFLEET_ADMIN_TOKEN?: string }).OPENFLEET_ADMIN_TOKEN ?? '',
};
