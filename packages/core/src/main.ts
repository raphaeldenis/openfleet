import { join } from 'node:path';
import { refuseBootOnFailure } from './bootFailure.js';
import { loadConfig, resolveHome } from './config.js';
import { startDaemon } from './daemon.js';
import { installProcessGuards } from './process/processGuards.js';
import { installShutdownHandler } from './process/shutdownHandler.js';

installProcessGuards();

const daemon = await refuseBootOnFailure(() => startDaemon(loadConfig()), {
  configPath: join(resolveHome(), 'config.json'),
  writeStderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
});

installShutdownHandler(daemon.close);
