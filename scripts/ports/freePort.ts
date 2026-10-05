import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const ANY_FREE_PORT = 0;

/** Resolves with the port the OS hands out on loopback, released again before returning. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port: ANY_FREE_PORT, host: LOOPBACK_HOST }, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => (port === undefined ? reject(new Error('no port was assigned')) : resolve(port)));
    });
  });
}

const HOLD_THEN_PRINT_PORTS_SCRIPT = `
const { createServer } = require('node:net');
const count = Number(process.argv[1]);
const holders = Array.from({ length: count }, () => createServer());
Promise.all(holders.map((holder) => new Promise((resolve) => holder.listen({ port: 0, host: '127.0.0.1' }, resolve))))
  .then(() => { console.log(JSON.stringify(holders.map((holder) => holder.address().port))); holders.forEach((holder) => holder.close()); });
`;

/** Returns `count` distinct free loopback ports; synchronous because Playwright evaluates its config synchronously. */
export function findFreePortsSync(count: number): number[] {
  const printedPorts = execFileSync(process.execPath, ['-e', HOLD_THEN_PRINT_PORTS_SCRIPT, String(count)], { encoding: 'utf8' });
  return JSON.parse(printedPorts) as number[];
}

/** True when nothing listens on `port` at loopback or on any interface. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port }, () => probe.close(() => resolve(true)));
  });
}

/** Resolves with the preferred port when free, otherwise with a free one. */
export async function preferPortOrFindFree(preferredPort: number): Promise<number> {
  const isPreferredFree = await isPortFree(preferredPort);
  return isPreferredFree ? preferredPort : findFreePort();
}
