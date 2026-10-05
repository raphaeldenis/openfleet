import { describe, expect, it } from 'vitest';
import { buildAllowedOrigins } from './allowedOrigins.js';

describe('buildAllowedOrigins', () => {
  it('allows the desktop shell origins when no extra origin is configured', () => {
    const origins = buildAllowedOrigins({});

    expect([...origins].sort()).toEqual(['http://localhost:1420', 'http://tauri.localhost', 'tauri://localhost']);
  });

  it('adds the loopback web origins listed in OPENFLEET_ALLOWED_ORIGINS', () => {
    const origins = buildAllowedOrigins({ OPENFLEET_ALLOWED_ORIGINS: 'http://localhost:51234, http://127.0.0.1:51235' });

    expect(buildAllowedOrigins({ OPENFLEET_ALLOWED_ORIGINS: 'http://[::1]:51236' }).has('http://[::1]:51236')).toBe(true);
    expect(origins.has('http://localhost:51234')).toBe(true);
    expect(origins.has('http://127.0.0.1:51235')).toBe(true);
    expect(origins.has('http://localhost:1420')).toBe(true);
  });

  it.each([
    ['a remote host', 'https://evil.example.com'],
    ['a path', 'http://localhost:51234/app'],
    ['a wildcard', '*'],
    ['a non-http scheme', 'file://localhost:51234'],
    ['a loopback lookalike', 'http://localhost.evil.com:51234'],
    ['a loopback host without a port', 'http://localhost'],
    ['a userinfo trick', 'http://localhost:51234@evil.com'],
    ['an out-of-range port', 'http://localhost:70000'],
    ['https on loopback', 'https://localhost:51234'],
  ])('ignores %s in OPENFLEET_ALLOWED_ORIGINS', (_label, rejectedOrigin) => {
    const origins = buildAllowedOrigins({ OPENFLEET_ALLOWED_ORIGINS: rejectedOrigin });

    expect(origins.has(rejectedOrigin)).toBe(false);
    expect(origins.size).toBe(3);
  });
});
