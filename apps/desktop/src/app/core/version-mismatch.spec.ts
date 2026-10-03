import { describe, expect, it } from 'vitest';
import { versionMismatchOf } from './version-mismatch';

describe('versionMismatchOf', () => {
  it.each([
    { appVersion: '1.2.0', daemonVersion: '0.9.2' },
    { appVersion: '0.2.0', daemonVersion: '0.2.1' },
    { appVersion: '0.2.0', daemonVersion: '0.2.0-dev' },
    { appVersion: '1.2.0', daemonVersion: '2.0.0' },
  ])('reports both versions when the app is $appVersion and the daemon is $daemonVersion', ({ appVersion, daemonVersion }) => {
    expect(versionMismatchOf({ appVersion, daemonVersion })).toEqual({ appVersion, daemonVersion });
  });

  it.each([
    { appVersion: '0.2.0', daemonVersion: '0.2.0' },
    { appVersion: '0.2.0', daemonVersion: 'v0.2.0' },
    { appVersion: '0.2.0', daemonVersion: ' 0.2.0 ' },
    { appVersion: '0.2.0', daemonVersion: '0.2.0+412' },
    { appVersion: '0.2.0-dev', daemonVersion: '0.2.0-dev' },
  ])('reports nothing when the app is $appVersion and the daemon is $daemonVersion', ({ appVersion, daemonVersion }) => {
    expect(versionMismatchOf({ appVersion, daemonVersion })).toBeNull();
  });

  it.each([
    { appVersion: null, daemonVersion: '0.2.0' },
    { appVersion: '0.2.0', daemonVersion: null },
    { appVersion: null, daemonVersion: null },
    { appVersion: '', daemonVersion: '0.2.0' },
    { appVersion: '0.2.0', daemonVersion: '   ' },
  ])('reports nothing when a version is unknown (app $appVersion, daemon $daemonVersion)', ({ appVersion, daemonVersion }) => {
    expect(versionMismatchOf({ appVersion, daemonVersion })).toBeNull();
  });
});
