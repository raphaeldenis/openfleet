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
    expect(environment.adminToken).toBe('');

    localStorage.setItem('openfleet.adminToken', 'written-after-import');

    expect(environment.adminToken).toBe('written-after-import');
  });
});
