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
    localStorage.setItem('openfleet.apiUrl', ' http://h:1/ ');

    expect(environment.apiUrl).toBe('http://h:1');
  });

  it('daemonAddress has no trailing slash when apiUrl was stored with one', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7331/');

    expect(environment.daemonAddress).toBe('127.0.0.1:7331');
  });

  it('apiUrl keeps a path prefix and strips only the trailing slash after it', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://h:1/openfleet/');

    expect(environment.apiUrl).toBe('http://h:1/openfleet');
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
});
