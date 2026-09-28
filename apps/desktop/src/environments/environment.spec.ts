import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { environment } from './environment.js';

describe('environment', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('apiUrl defaults to the local daemon address when nothing is stored', () => {
    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  it('apiUrl reflects the address stored in localStorage', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:9999');

    expect(environment.apiUrl).toBe('http://127.0.0.1:9999');
  });

  it('adminToken defaults to an empty string when nothing is stored', () => {
    expect(environment.adminToken).toBe('');
  });

  it('adminToken is read live: a value written to storage after the module was imported is still seen', () => {
    localStorage.setItem('openfleet.adminToken', 'written-after-import');

    expect(environment.adminToken).toBe('written-after-import');
  });

  it('daemonAddress strips the scheme from apiUrl when nothing is stored', () => {
    expect(environment.daemonAddress).toBe('127.0.0.1:7331');
  });

  it('daemonAddress reflects an apiUrl overridden in localStorage, same source as the socket', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:9999');

    expect(environment.daemonAddress).toBe('127.0.0.1:9999');
  });

  it('apiUrl strips a single trailing slash stored in localStorage', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7331/');

    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  it('apiUrl strips repeated trailing slashes stored in localStorage', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7331//');

    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  it('apiUrl trims surrounding whitespace and a trailing slash stored in localStorage', () => {
    localStorage.setItem('openfleet.apiUrl', ' http://127.0.0.1:1/ ');

    expect(environment.apiUrl).toBe('http://127.0.0.1:1');
  });

  it('daemonAddress has no trailing slash when apiUrl was stored with one', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7331/');

    expect(environment.daemonAddress).toBe('127.0.0.1:7331');
  });

  it('apiUrl keeps a path prefix and strips only the trailing slash after it', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:1/openfleet/');

    expect(environment.apiUrl).toBe('http://127.0.0.1:1/openfleet');
  });

  it('apiUrl normalizes an IPv6 host stored with a trailing slash', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://[::1]:7331/');

    expect(environment.apiUrl).toBe('http://[::1]:7331');
    expect(environment.daemonAddress).toBe('[::1]:7331');
  });

  it('apiUrl falls back to the default when a whitespace-only stored value normalizes to nothing', () => {
    localStorage.setItem('openfleet.apiUrl', '   ');

    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  it('apiUrl falls back to the default when a slashes-only stored value normalizes to nothing', () => {
    localStorage.setItem('openfleet.apiUrl', '/');

    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  it('apiUrl falls back to the default when the stored value has no http(s) scheme', () => {
    localStorage.setItem('openfleet.apiUrl', '127.0.0.1:7331');

    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  it('apiUrl falls back to the default when the stored value uses an unsupported scheme', () => {
    localStorage.setItem('openfleet.apiUrl', 'ftp://h');

    expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
  });

  describe('a stored apiUrl that does not point at the loopback daemon', () => {
    const hostileStoredApiUrls = [
      ['a remote host', 'http://evil:1'],
      ['a remote https host', 'https://evil.com'],
      ['a host that starts with localhost', 'http://localhost.evil.com'],
      ['a host that starts with localhost, with a port', 'http://localhost.evil.com:7331'],
      ['userinfo hiding the real host', 'http://x@evil.com'],
      ['loopback as the userinfo of a remote host', 'http://127.0.0.1@evil.com'],
      ['loopback as the userinfo of a remote host, with a port', 'http://127.0.0.1:7331@evil.com'],
      ['userinfo in front of a loopback host', 'http://user:pass@127.0.0.1:7331'],
      ['a wildcard-DNS host embedding the loopback address', 'http://127.0.0.1.nip.io'],
      ['the IPv4-mapped IPv6 loopback', 'http://[::ffff:7f00:1]:7331'],
      ['another address of the 127.0.0.0/8 block', 'http://127.0.0.2:7331'],
      ['the unspecified address', 'http://0.0.0.0:7331'],
      ['a LAN address', 'http://192.168.1.10:7331'],
      ['a remote host with uppercase letters', 'HTTP://EVIL.COM:1'],
      ['a query string', 'http://127.0.0.1:7331?x=1'],
      ['a query string after a slash', 'http://127.0.0.1:7331/?x=1'],
      ['an empty query string', 'http://127.0.0.1:7331/?'],
      ['a fragment', 'http://127.0.0.1:7331#frag'],
      ['an empty fragment', 'http://127.0.0.1:7331/#'],
      ['a query with no host', 'https://?x'],
      ['an empty authority', 'http:///h'],
      ['no host at all', 'http://'],
      ['a newline hidden inside the scheme of a remote host','ht\ntp://evil:1'],
    ] as const;

    it.each(hostileStoredApiUrls)('apiUrl falls back to the default for %s (%s)', (_label, storedApiUrl) => {
      localStorage.setItem('openfleet.apiUrl', storedApiUrl);

      expect(environment.apiUrl).toBe('http://127.0.0.1:7331');
      expect(environment.daemonAddress).toBe('127.0.0.1:7331');
    });
  });

  describe('a stored apiUrl that points at the loopback daemon', () => {
    const loopbackStoredApiUrls = [
      ['127.0.0.1 on another port', 'http://127.0.0.1:9999', 'http://127.0.0.1:9999'],
      ['localhost', 'http://localhost:7331', 'http://localhost:7331'],
      ['localhost in uppercase', 'HTTP://LOCALHOST:7331', 'http://localhost:7331'],
      ['the IPv6 loopback', 'http://[::1]:7331', 'http://[::1]:7331'],
      ['a loopback host over https', 'https://127.0.0.1:7331', 'https://127.0.0.1:7331'],
      ['a loopback host without a port', 'http://localhost', 'http://localhost'],
      ['a loopback host with a path prefix', 'http://localhost:7331/openfleet/', 'http://localhost:7331/openfleet'],
    ] as const;

    it.each(loopbackStoredApiUrls)('apiUrl keeps %s (%s)', (_label, storedApiUrl, expectedApiUrl) => {
      localStorage.setItem('openfleet.apiUrl', storedApiUrl);

      expect(environment.apiUrl).toBe(expectedApiUrl);
    });
  });

  describe('adminToken', () => {
    it.each([
      ['spaces only', '   '],
      ['a tab and a newline only', '\t\n'],
    ])('is empty when the stored token is %s', (_label, storedToken) => {
      localStorage.setItem('openfleet.adminToken', storedToken);

      expect(environment.adminToken).toBe('');
    });

    it('drops the whitespace around a stored token', () => {
      localStorage.setItem('openfleet.adminToken', '  secret-token\n');

      expect(environment.adminToken).toBe('secret-token');
    });
  });
});
