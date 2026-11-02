import { join } from 'node:path';
import { refuseBootOnFailure } from './bootFailure.js';
import { loadConfig, resolveHome } from './config.js';
import { startDaemon } from './daemon.js';
import { CRASH_FOLDER_NAME } from './process/crashFile.js';
import { createDegradedRegistry } from './process/degradedRegistry.js';
import { installProcessGuards } from './process/processGuards.js';
import { installShutdownHandler } from './process/shutdownHandler.js';
import { EXIT_ON_STDIN_EOF_VARIABLE, shutdownOnStdinEof } from './process/stdinEofShutdown.js';
import { createStdioSecretParentLink } from './secrets/stdioSecretParentLink.js';
import { usageIngestionEnabledBy } from './usageIngestionEnv.js';

const degraded = createDegradedRegistry();
let isShuttingDown = false;
installProcessGuards(process, { degraded, crashDir: join(resolveHome(), CRASH_FOLDER_NAME), isShuttingDown: () => isShuttingDown });

// Only the desktop app's sidecar has an app on the other end of its pipes: a daemon started from a shell has no keychain to ask.
const isSidecarOfTheApp = process.env[EXIT_ON_STDIN_EOF_VARIABLE] === '1';
const secretParent = isSidecarOfTheApp ? createStdioSecretParentLink({ input: process.stdin, output: process.stdout }) : undefined;

const booting = refuseBootOnFailure(() => startDaemon(loadConfig(), { degraded, usageIngestion: usageIngestionEnabledBy(process.env), secrets: { parent: secretParent } }), {
  configPath: join(resolveHome(), 'config.json'),
  writeStderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
});

// Armed before the daemon listens: a signal during boot waits for the boot to finish, then closes it.
const shutdown = installShutdownHandler(async () => (await booting).close(), process, { onShutdownBegin: () => { isShuttingDown = true; } });
shutdownOnStdinEof(shutdown, process.stdin, process.env);

await booting;
