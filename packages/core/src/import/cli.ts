import { homedir } from 'node:os';
import { runImportCli } from './importCli.js';

const { exitCode, output } = runImportCli(process.argv.slice(2), { homeDirectory: homedir() });
process.stdout.write(output);
process.exit(exitCode);
