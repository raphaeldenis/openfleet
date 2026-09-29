import { setAdminToken } from './admin-token.store.js';

export async function ensureAdminTokenLoaded(): Promise<void> {
  // Outside Tauri (plain browser, e2e) the token already lives in localStorage — pasted once by hand,
  // or written by the e2e harness's addInitScript — so there is nothing to load: environment.adminToken
  // falls back to reading it from there itself.
  const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
  if (!isTauriWebview) return;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const token = await invoke<string>('read_admin_token');
    if (token) setAdminToken(token);
  } catch (error) {
    console.error('could not read the admin token from Tauri', error);
  } finally {
    // Pre-fix builds wrote the token to localStorage even inside Tauri; purge any leftover.
    globalThis.localStorage?.removeItem('openfleet.adminToken');
  }
}
