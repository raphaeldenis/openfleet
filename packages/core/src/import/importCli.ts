import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { renderImportReport } from './scape/importReport.js';
import { importScape, type ImportScapeOptions } from './scape/importScape.js';
import { ScapeImportError } from './scape/scapeImportError.js';

const EXIT_OK = 0;
const EXIT_IMPORT_FAILED = 1;
const EXIT_INVALID_ARGUMENTS = 2;

export interface CliResult { exitCode: number; output: string }
export interface CliEnvironment { homeDirectory: string; env: NodeJS.ProcessEnv }

const FLAGS = {
  home: { type: 'string' },
  'dry-run': { type: 'boolean' },
  project: { type: 'string' },
  'scape-dir': { type: 'string' },
  'report-dir': { type: 'string' },
} as const;

const invalidArguments = (message: string) => new ScapeImportError({ code: 'INVALID_ARGUMENTS', message });

function parseFlags(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: FLAGS, allowPositionals: true });
  } catch (cause) {
    throw invalidArguments((cause as Error).message);
  }
}

function parseImportOptions(argv: string[], environment: CliEnvironment): ImportScapeOptions {
  const { values, positionals } = parseFlags(argv);
  if (positionals.join(' ') !== 'scape') throw invalidArguments('usage: import scape --home <OPENFLEET_HOME> [--dry-run] [--project <name>] [--scape-dir <dir>] [--report-dir <dir>]');
  const home = values.home ?? environment.env.OPENFLEET_HOME;
  if (home === undefined || home === '') throw invalidArguments('--home <OPENFLEET_HOME> is required (or set OPENFLEET_HOME)');
  return {
    home,
    scapeDir: values['scape-dir'] ?? join(environment.homeDirectory, '.scape'),
    superpowersRoot: join(environment.homeDirectory, 'Documents', 'superpowers'),
    dryRun: values['dry-run'] ?? false,
    projectName: values.project,
    reportDir: values['report-dir'],
  };
}

/** Runs `import scape` with the given arguments and never exits, so the entry point owns the process. Import failures come back as an exit code and their code; a bug propagates. */
export function runImportCli(argv: string[], environment: CliEnvironment): CliResult {
  try {
    const options = parseImportOptions(argv, environment);
    const report = importScape(options);
    const output = report.dryRun ? renderImportReport(report) : `Import written. Report: ${report.reportPath}\n`;
    return { exitCode: EXIT_OK, output };
  } catch (error) {
    if (!(error instanceof ScapeImportError)) throw error;
    const exitCode = error.code === 'INVALID_ARGUMENTS' ? EXIT_INVALID_ARGUMENTS : EXIT_IMPORT_FAILED;
    return { exitCode, output: `${error.code}: ${error.message}\n` };
  }
}
