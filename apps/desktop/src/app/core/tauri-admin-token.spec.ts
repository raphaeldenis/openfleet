import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminToken, setAdminToken } from './admin-token.store.js';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

async function importFresh() {
  const module = await import('./tauri-admin-token.js');
  return module.ensureAdminTokenLoaded;
}

describe('ensureAdminTokenLoaded', () => {
  beforeEach(() => {
    localStorage.clear();
    setAdminToken('');
    invokeMock.mockReset();
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('does nothing outside a Tauri webview, leaving the in-memory token empty for the localStorage fallback to cover', async () => {
    localStorage.setItem('openfleet.adminToken', 'pasted-by-hand');
    const ensureAdminTokenLoaded = await importFresh();

    await ensureAdminTokenLoaded();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(getAdminToken()).toBe('');
  });

  it('writes the token returned by the Tauri command into memory, never into localStorage', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue('secret-token');
    const ensureAdminTokenLoaded = await importFresh();

    await ensureAdminTokenLoaded();

    expect(invokeMock).toHaveBeenCalledWith('read_admin_token');
    expect(getAdminToken()).toBe('secret-token');
    expect(localStorage.getItem('openfleet.adminToken')).toBeNull();
  });

  it('leaves the in-memory token empty when the Tauri command rejects', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error('no such file'));
    const ensureAdminTokenLoaded = await importFresh();

    await ensureAdminTokenLoaded();

    expect(getAdminToken()).toBe('');
  });

  it('does not overwrite an already-loaded token when the Tauri command resolves an empty string', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setAdminToken('existing');
    invokeMock.mockResolvedValue('');
    const ensureAdminTokenLoaded = await importFresh();

    await ensureAdminTokenLoaded();

    expect(getAdminToken()).toBe('existing');
  });

  it('overwrites a stale token already in memory with the freshly read one', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setAdminToken('stale-token');
    invokeMock.mockResolvedValue('fresh-token');
    const ensureAdminTokenLoaded = await importFresh();

    await ensureAdminTokenLoaded();

    expect(getAdminToken()).toBe('fresh-token');
  });

  it('stores whatever the Tauri command resolves, trimmed of surrounding whitespace', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue('token-with-trailing-newline\n');
    const ensureAdminTokenLoaded = await importFresh();

    await ensureAdminTokenLoaded();

    expect(getAdminToken()).toBe('token-with-trailing-newline');
  });
});
