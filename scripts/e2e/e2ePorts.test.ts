import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { E2E_API_ENV, E2E_WEB_URL_ENV, resolveE2ePorts } from './e2ePorts.js';

const openListeners: Server[] = [];

async function occupy(port: number): Promise<void> {
  const listener = createServer();
  openListeners.push(listener);
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen({ port, host: '127.0.0.1' }, resolve); });
}

afterEach(async () => {
  await Promise.all(openListeners.splice(0).map((listener) => new Promise((resolve) => listener.close(resolve))));
});

describe('resolveE2ePorts', () => {
  it('announces the daemon and web urls in the environment so Playwright workers see the same ports', () => {
    const env: NodeJS.ProcessEnv = {};

    const ports = resolveE2ePorts(env);

    expect(env[E2E_API_ENV]).toBe(`http://127.0.0.1:${ports.daemonPort}`);
    expect(env[E2E_WEB_URL_ENV]).toBe(`http://localhost:${ports.webPort}`);
  });

  it('picks two distinct ports, neither of them the dev defaults held by a developer server', async () => {
    const heldDevPorts = [51420, 51331];
    await Promise.all(heldDevPorts.map(occupy));

    const { webPort, daemonPort } = resolveE2ePorts({});

    expect(webPort).not.toBe(daemonPort);
    expect(heldDevPorts).not.toContain(webPort);
    expect(heldDevPorts).not.toContain(daemonPort);
  });

  it('reuses the ports already announced in the environment instead of picking others', () => {
    const env: NodeJS.ProcessEnv = {};
    const firstEvaluation = resolveE2ePorts(env);

    const workerEvaluation = resolveE2ePorts(env);

    expect(workerEvaluation).toEqual(firstEvaluation);
  });

  it('honors OPENFLEET_E2E_PORTS="web,daemon" for a deterministic run', () => {
    const env: NodeJS.ProcessEnv = { OPENFLEET_E2E_PORTS: '4200,7400' };

    expect(resolveE2ePorts(env)).toEqual({ webPort: 4200, daemonPort: 7400 });
  });

  it.each(['4200', 'a,b', '4200,4200', '0,7400', '4200,70000', '4200,7400,1'])('rejects OPENFLEET_E2E_PORTS="%s" naming the expected shape', (invalidValue) => {
    expect(() => resolveE2ePorts({ OPENFLEET_E2E_PORTS: invalidValue })).toThrow('OPENFLEET_E2E_PORTS');
  });
});
