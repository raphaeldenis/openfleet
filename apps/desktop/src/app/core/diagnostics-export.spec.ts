import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

async function injectFresh() {
  vi.resetModules();
  const { TestBed } = await import('@angular/core/testing');
  const { DiagnosticsExport } = await import('./diagnostics-export');
  return TestBed.inject(DiagnosticsExport);
}

const unsetTauriMarker = () => delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

describe('DiagnosticsExport under Tauri', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(unsetTauriMarker);

  it('is available and reads the desktop log through read_desktop_log', async () => {
    invokeMock.mockResolvedValue('log text');
    const exporter = await injectFresh();

    const log = await exporter.readDesktopLog();

    expect(exporter.isAvailable).toBe(true);
    expect(log).toBe('log text');
    expect(invokeMock).toHaveBeenCalledWith('read_desktop_log');
  });

  it('sends the zip as the raw body with the suggested name in a header, and returns the outcome', async () => {
    invokeMock.mockResolvedValue({ status: 'saved', path: '/Users/x/b.zip' });
    const exporter = await injectFresh();
    const bytes = new Uint8Array([0x50, 0x4b]);

    const outcome = await exporter.saveBundle({ fileName: 'openfleet-diagnostics-x.zip', bytes });

    expect(outcome).toEqual({ status: 'saved', path: '/Users/x/b.zip' });
    expect(invokeMock).toHaveBeenCalledWith('save_diagnostics_bundle', bytes, { headers: { 'x-default-name': 'openfleet-diagnostics-x.zip' } });
  });

  it('reveals through the argument-less reveal_diagnostics_bundle command', async () => {
    invokeMock.mockResolvedValue(undefined);
    const exporter = await injectFresh();

    await exporter.revealSavedBundle();

    expect(invokeMock).toHaveBeenCalledWith('reveal_diagnostics_bundle');
  });

  it('is unavailable in a plain browser', async () => {
    unsetTauriMarker();

    expect((await injectFresh()).isAvailable).toBe(false);
  });
});
