import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('daemon version', () => {
  it('is "dev" when the bundler injected no version (tsx, vitest)', async () => {
    const { DAEMON_VERSION } = await import('./version.js');
    expect(DAEMON_VERSION).toBe('dev');
  });

  it('is the version the bundler injected at build time', async () => {
    vi.stubGlobal('__OPENFLEET_VERSION__', '0.2.0');
    const { DAEMON_VERSION } = await import('./version.js');
    expect(DAEMON_VERSION).toBe('0.2.0');
  });
});
