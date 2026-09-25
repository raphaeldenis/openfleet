const ADMIN_TOKEN_STORAGE_KEY = 'openfleet.adminToken';

export async function ensureAdminTokenInStorage(): Promise<void> {
  const token = await readFromTauri();
  if (token) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  // Outside Tauri (plain browser, e2e) the token already lives in localStorage — pasted once by hand,
  // or written by the e2e harness's addInitScript — so there is nothing to do.
}

async function readFromTauri(): Promise<string | undefined> {
  const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
  if (!isTauriWebview) return undefined;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<string>('read_admin_token');
  } catch (error) {
    console.error('could not read the admin token from Tauri', error);
    return undefined;
  }
}
