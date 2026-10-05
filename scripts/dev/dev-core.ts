import { resolveDevDaemonPort } from './devDaemonPort.js';

const WEB_DEV_SERVER_URL = 'http://localhost:1420';

const { port, isFallback } = await resolveDevDaemonPort({ env: process.env });
process.env.OPENFLEET_PORT = String(port);

if (isFallback) {
  const daemonUrl = `http://127.0.0.1:${port}`;
  process.stderr.write(`openfleet: port 7331 is taken, the dev daemon listens on ${port} instead.\n`);
  process.stderr.write(`openfleet: open the web app on it with ${WEB_DEV_SERVER_URL}/?daemon=${encodeURIComponent(daemonUrl)} (the Tauri window needs 7331 and cannot follow).\n`);
}

await import('../../packages/core/src/daemonEntry.js');
