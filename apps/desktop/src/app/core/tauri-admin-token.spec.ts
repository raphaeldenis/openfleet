import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

async function importFresh() {
  const module = await import('./tauri-admin-token.js');
  return module.ensureAdminTokenInStorage;
}

describe('ensureAdminTokenInStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('does nothing outside a Tauri webview, leaving localStorage untouched', async () => {
    localStorage.setItem('openfleet.adminToken', 'pasted-by-hand');
    const ensureAdminTokenInStorage = await importFresh();

    await ensureAdminTokenInStorage();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('openfleet.adminToken')).toBe('pasted-by-hand');
  });

  it('writes the token returned by the Tauri command into localStorage', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue('secret-token');
    const ensureAdminTokenInStorage = await importFresh();

    await ensureAdminTokenInStorage();

    expect(invokeMock).toHaveBeenCalledWith('read_admin_token');
    expect(localStorage.getItem('openfleet.adminToken')).toBe('secret-token');
  });

  it('leaves localStorage untouched when the Tauri command rejects', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    localStorage.setItem('openfleet.adminToken', 'existing');
    invokeMock.mockRejectedValue(new Error('no such file'));
    const ensureAdminTokenInStorage = await importFresh();

    await ensureAdminTokenInStorage();

    expect(localStorage.getItem('openfleet.adminToken')).toBe('existing');
  });
});
