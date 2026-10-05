import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort, isPortFree, preferPortOrFindFree } from './freePort.js';

const openListeners: Server[] = [];

async function occupyAnyPort(): Promise<number> {
  const listener = createServer();
  openListeners.push(listener);
  await new Promise<void>((resolve) => listener.listen({ port: 0 }, resolve));
  return (listener.address() as { port: number }).port;
}

afterEach(async () => {
  await Promise.all(openListeners.splice(0).map((listener) => new Promise((resolve) => listener.close(resolve))));
});

describe('findFreePort', () => {
  it('returns a port nothing listens on', async () => {
    const port = await findFreePort();

    expect(await isPortFree(port)).toBe(true);
  });

  it('returns different ports while the first one is held', async () => {
    const heldPort = await occupyAnyPort();

    const port = await findFreePort();

    expect(port).not.toBe(heldPort);
  });
});

describe('isPortFree', () => {
  it('is false for a port a listener holds', async () => {
    const heldPort = await occupyAnyPort();

    expect(await isPortFree(heldPort)).toBe(false);
  });
});

describe('preferPortOrFindFree', () => {
  it('keeps the preferred port when it is free', async () => {
    const preferredPort = await findFreePort();

    expect(await preferPortOrFindFree(preferredPort)).toBe(preferredPort);
  });

  it('falls back to another free port when the preferred one is held', async () => {
    const heldPort = await occupyAnyPort();

    const port = await preferPortOrFindFree(heldPort);

    expect(port).not.toBe(heldPort);
    expect(await isPortFree(port)).toBe(true);
  });
});
