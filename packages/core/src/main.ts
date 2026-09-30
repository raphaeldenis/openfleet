import { join } from 'node:path';
import { refuseBootOnFailure } from './bootFailure.js';
import { loadConfig, resolveHome } from './config.js';
import { startDaemon } from './daemon.js';
import { CRASH_FOLDER_NAME } from './process/crashFile.js';
import { createDegradedRegistry } from './process/degradedRegistry.js';
import { installProcessGuards } from './process/processGuards.js';
import { installShutdownHandler } from './process/shutdownHandler.js';
import { shutdownOnStdinEof } from './process/stdinEofShutdown.js';

const degraded = createDegradedRegistry();
installProcessGuards(process, { degraded, crashDir: join(resolveHome(), CRASH_FOLDER_NAME) });

const booting = refuseBootOnFailure(() => startDaemon(loadConfig(), { degraded }), {
  configPath: join(resolveHome(), 'config.json'),
  writeStderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
});

// Armed before the daemon listens: a signal during boot waits for the boot to finish, then closes it.
const shutdown = installShutdownHandler(async () => (await booting).close());
shutdownOnStdinEof(shutdown, process.stdin, process.env);

await booting;
