import { join } from 'node:path';
import { refuseBootOnFailure } from './bootFailure.js';
import { loadConfig, resolveHome } from './config.js';
import { startDaemon } from './daemon.js';
import { installProcessGuards } from './process/processGuards.js';
import { installShutdownHandler } from './process/shutdownHandler.js';

installProcessGuards();

const booting = refuseBootOnFailure(() => startDaemon(loadConfig()), {
  configPath: join(resolveHome(), 'config.json'),
  writeStderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
});

// Armed before the daemon listens: a signal during boot waits for the boot to finish, then closes it.
installShutdownHandler(async () => (await booting).close());

await booting;
