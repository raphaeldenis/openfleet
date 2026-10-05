import { findFreePortsSync } from '../ports/freePort.js';

export const E2E_API_ENV = 'OPENFLEET_E2E_API';
export const E2E_WEB_URL_ENV = 'OPENFLEET_E2E_WEB_URL';
const E2E_PORTS_OVERRIDE_ENV = 'OPENFLEET_E2E_PORTS';
const MAX_PORT = 65535;

export interface E2ePorts { webPort: number; daemonPort: number }

const daemonUrlOf = (port: number) => `http://127.0.0.1:${port}`;
const webUrlOf = (port: number) => `http://localhost:${port}`;
const portOf = (url: string) => Number(new URL(url).port);

function parseOverride(override: string): E2ePorts {
  const fail = () => new Error(`${E2E_PORTS_OVERRIDE_ENV} must be "<webPort>,<daemonPort>" with two different ports between 1 and ${MAX_PORT}, got "${override}"`);
  const parts = override.split(',').map((part) => Number(part.trim()));
  const [webPort, daemonPort] = parts;
  const hasTwoParts = parts.length === 2 && webPort !== undefined && daemonPort !== undefined;
  if (!hasTwoParts) throw fail();
  const arePorts = [webPort, daemonPort].every((port) => Number.isInteger(port) && port >= 1 && port <= MAX_PORT);
  if (!arePorts || webPort === daemonPort) throw fail();
  return { webPort, daemonPort };
}

function pickFreePorts(): E2ePorts {
  const [webPort, daemonPort] = findFreePortsSync(2);
  if (webPort === undefined || daemonPort === undefined) throw new Error('no free ports were assigned for the e2e run');
  return { webPort, daemonPort };
}

/**
 * Resolves the web and daemon ports of an e2e run and announces them in `env` (the Playwright config is evaluated again in every worker,
 * and the specs read the daemon url from there): the ports announced already, else OPENFLEET_E2E_PORTS, else two free ports.
 */
export function resolveE2ePorts(env: NodeJS.ProcessEnv = process.env): E2ePorts {
  const announcedApi = env[E2E_API_ENV];
  const announcedWebUrl = env[E2E_WEB_URL_ENV];
  if (announcedApi && announcedWebUrl) return { webPort: portOf(announcedWebUrl), daemonPort: portOf(announcedApi) };

  const override = env[E2E_PORTS_OVERRIDE_ENV];
  const ports = override ? parseOverride(override) : pickFreePorts();
  env[E2E_API_ENV] = daemonUrlOf(ports.daemonPort);
  env[E2E_WEB_URL_ENV] = webUrlOf(ports.webPort);
  return ports;
}
