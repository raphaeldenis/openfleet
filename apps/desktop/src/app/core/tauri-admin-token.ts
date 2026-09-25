const ADMIN_TOKEN_STORAGE_KEY = 'openfleet.adminToken';

export async function ensureAdminTokenInStorage(): Promise<void> {
  // Outside Tauri (plain browser, e2e) the token already lives in localStorage — pasted once by hand,
  // or written by the e2e harness's addInitScript — so there is nothing to do.
  const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
  if (!isTauriWebview) return;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const token = await invoke<string>('read_admin_token');
    if (token) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  } catch (error) {
    console.error('could not read the admin token from Tauri', error);
  }
}
