import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

async function importFresh() {
  vi.resetModules();
  return (await import('./support-actions')).SupportActions;
}

function unsetTauriMarker() {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

describe('SupportActions under Tauri', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(unsetTauriMarker);

  it('is available and calls the argument-less reveal_logs command', async () => {
    const { TestBed } = await import('@angular/core/testing');
    const SupportActions = await importFresh();
    const support = TestBed.inject(SupportActions);

    await support.revealLogs();

    expect(support.isAvailable).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('reveal_logs');
  });

  it('calls the argument-less report_issue command', async () => {
    const { TestBed } = await import('@angular/core/testing');
    const SupportActions = await importFresh();
    const support = TestBed.inject(SupportActions);

    await support.reportIssue();

    expect(invokeMock).toHaveBeenCalledWith('report_issue');
  });

  it('is unavailable in a plain browser', async () => {
    unsetTauriMarker();
    const { TestBed } = await import('@angular/core/testing');
    const SupportActions = await importFresh();

    expect(TestBed.inject(SupportActions).isAvailable).toBe(false);
  });
});
