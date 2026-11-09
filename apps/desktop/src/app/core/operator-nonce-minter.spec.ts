import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

async function injectFresh() {
  vi.resetModules();
  const { TestBed } = await import('@angular/core/testing');
  const { OperatorNonceMinter } = await import('./operator-nonce-minter');
  return TestBed.inject(OperatorNonceMinter);
}

const unsetTauriMarker = () => delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

describe('OperatorNonceMinter inside the desktop app', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(unsetTauriMarker);

  it('asks the shell for a nonce that arms that trigger and no other', async () => {
    invokeMock.mockResolvedValue('nonce-1');
    const minter = await injectFresh();

    const nonce = await minter.mintTriggerArmingNonce('t1');

    expect(nonce).toBe('nonce-1');
    expect(invokeMock).toHaveBeenCalledWith('mint_operator_nonce', { action: 'trigger.arm', scopeKind: 'trigger', scopeId: 't1', name: 't1' });
  });

  it('lets a refusal of the shell reach the caller', async () => {
    invokeMock.mockRejectedValue('the daemon of this app is not running');
    const minter = await injectFresh();

    await expect(minter.mintTriggerArmingNonce('t1')).rejects.toBe('the daemon of this app is not running');
  });
});

describe('OperatorNonceMinter outside the desktop app', () => {
  beforeEach(() => invokeMock.mockReset());

  it('rejects without calling the shell', async () => {
    const minter = await injectFresh();

    await expect(minter.mintTriggerArmingNonce('t1')).rejects.toThrow('desktop app');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
