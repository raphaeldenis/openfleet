import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, refuseUnlessFromTheDesktopApp } from './internalSecretRoutes.js';

const requestFrom = ({ address, headers = {} }: { address: string | undefined; headers?: Record<string, string> }) =>
  ({ socket: { remoteAddress: address }, headers }) as unknown as IncomingMessage;

describe('the guard of the internal secret routes', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('takes %s for loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([['a LAN address', '192.168.1.20'], ['a public address', '203.0.113.9'], ['no address', undefined]])('does not take %s for loopback', (_label, address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it('lets a bare loopback request through', () => {
    expect(() => refuseUnlessFromTheDesktopApp(requestFrom({ address: '127.0.0.1' }))).not.toThrow();
  });

  it.each([
    ['a request from outside the machine', { address: '192.168.1.20' }],
    ['a request with an Origin header', { address: '127.0.0.1', headers: { origin: 'http://localhost:4200' } }],
    ['a request with an Authorization header', { address: '127.0.0.1', headers: { authorization: 'Bearer anything' } }],
  ])('refuses %s with the one refusal', (_label, request) => {
    expect(() => refuseUnlessFromTheDesktopApp(requestFrom(request))).toThrow(expect.objectContaining({ code: 'secret_nonce_invalid' }));
  });
});
