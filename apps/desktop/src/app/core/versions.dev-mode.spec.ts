import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionsService } from './versions.service';

// Black-box: a development build of the app shows "dev" (like the source daemon), a production build shows its bundle version.

vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.2.0') }));

function runningAs({ build }: { build: 'development' | 'production' }) {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('ngDevMode', build === 'development' ? {} : false);
}

async function appTalkingToDaemon({ daemonVersion }: { daemonVersion: string }) {
  const versions = TestBed.inject(VersionsService);
  await versions.loadAppVersion();
  versions.recordDaemonHealth({ version: daemonVersion });
  return versions;
}

describe('the app version in a Tauri webview', () => {
  beforeEach(() => TestBed.configureTestingModule({}));
  afterEach(() => vi.unstubAllGlobals());

  it('is "dev" in a development build, so `tauri dev` against a source daemon raises no version mismatch', async () => {
    runningAs({ build: 'development' });

    const versions = await appTalkingToDaemon({ daemonVersion: 'dev' });

    expect(versions.appVersion()).toBe('dev');
    expect(versions.mismatch()).toBeNull();
  });

  it('is the bundle version in a production build', async () => {
    runningAs({ build: 'production' });

    const versions = await appTalkingToDaemon({ daemonVersion: '0.2.0' });

    expect(versions.appVersion()).toBe('0.2.0');
    expect(versions.mismatch()).toBeNull();
  });

  it('flags a packaged app that reached a leftover source daemon', async () => {
    runningAs({ build: 'production' });

    const versions = await appTalkingToDaemon({ daemonVersion: 'dev' });

    expect(versions.mismatch()).toEqual({ appVersion: '0.2.0', daemonVersion: 'dev' });
  });
});
