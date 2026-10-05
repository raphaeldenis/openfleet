import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../ports/freePort.js';
import { resolveDevDaemonPort } from './devDaemonPort.js';

const openListeners: Server[] = [];

async function occupy(port: number): Promise<void> {
  const listener = createServer();
  openListeners.push(listener);
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen({ port }, resolve); });
}

afterEach(async () => {
  await Promise.all(openListeners.splice(0).map((listener) => new Promise((resolve) => listener.close(resolve))));
});

describe('resolveDevDaemonPort', () => {
  it('keeps the preferred port when it is free', async () => {
    const preferredPort = await findFreePort();

    const resolution = await resolveDevDaemonPort({ env: {}, preferredPort });

    expect(resolution).toEqual({ port: preferredPort, isFallback: false });
  });

  it('falls back to another free port when the preferred one is taken', async () => {
    const preferredPort = await findFreePort();
    await occupy(preferredPort);

    const resolution = await resolveDevDaemonPort({ env: {}, preferredPort });

    expect(resolution.isFallback).toBe(true);
    expect(resolution.port).not.toBe(preferredPort);
  });

  it('leaves an explicit OPENFLEET_PORT untouched even when it is taken, so the daemon refuses to boot on it', async () => {
    const explicitPort = await findFreePort();
    await occupy(explicitPort);

    const resolution = await resolveDevDaemonPort({ env: { OPENFLEET_PORT: String(explicitPort) }, preferredPort: explicitPort });

    expect(resolution).toEqual({ port: explicitPort, isFallback: false });
  });
});
