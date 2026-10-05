import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptDaemonUrlFromQuery } from './environment.js';

const STORAGE_KEY = 'openfleet.apiUrl';
const queryFor = (daemonUrl: string) => `?daemon=${encodeURIComponent(daemonUrl)}`;

describe('adoptDaemonUrlFromQuery', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it.each(['http://127.0.0.1:7500', 'http://localhost:7500', 'http://[::1]:7500'])('stores the loopback daemon %s so the app talks to it', (loopbackDaemon) => {
    adoptDaemonUrlFromQuery(queryFor(loopbackDaemon));

    expect(localStorage.getItem(STORAGE_KEY)).toBe(loopbackDaemon);
  });

  it('leaves the stored daemon alone when the query names none', () => {
    localStorage.setItem(STORAGE_KEY, 'http://127.0.0.1:9999');

    adoptDaemonUrlFromQuery('?other=1');

    expect(localStorage.getItem(STORAGE_KEY)).toBe('http://127.0.0.1:9999');
  });

  it.each([
    ['a remote host', 'https://evil.example.com:7500'],
    ['a remote http host', 'http://evil.example.com:7500'],
    ['a loopback lookalike', 'http://localhost.evil.com:7500'],
    ['a userinfo trick', 'http://127.0.0.1:7500@evil.com'],
    ['a loopback host without a port', 'http://127.0.0.1'],
    ['an out-of-range port', 'http://127.0.0.1:70000'],
    ['a path', 'http://127.0.0.1:7500/steal'],
    ['a query', 'http://127.0.0.1:7500?x=1'],
    ['https on loopback', 'https://127.0.0.1:7500'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['an empty value', ''],
  ])('ignores %s and keeps the stored daemon', (_label, rejectedDaemon) => {
    localStorage.setItem(STORAGE_KEY, 'http://127.0.0.1:9999');

    adoptDaemonUrlFromQuery(queryFor(rejectedDaemon));

    expect(localStorage.getItem(STORAGE_KEY)).toBe('http://127.0.0.1:9999');
  });
});
