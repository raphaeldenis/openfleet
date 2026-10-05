import { join, relative, resolve, sep } from 'node:path';
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
  'state-dir': { type: 'string' },
  'claude-dir': { type: 'string' },
  'scape-claude-dir': { type: 'string' },
  'allow-reimport': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

const REIMPORT_NOTE =
  'A re-import compares each record with what the last import wrote: a Scape change is applied to a record OpenFleet left alone; a record edited or deleted in OpenFleet is a conflict and is kept (a deleted one is never written again); a record removed in Scape is reported and kept. Run --dry-run first to see the outcome per entity.';

const USAGE = [
  'usage: import scape --home <OPENFLEET_HOME> [--dry-run] [--project <name>] [--scape-dir <dir>] [--report-dir <dir>] [--state-dir <dir>] [--claude-dir <dir>] [--scape-claude-dir <dir>] [--allow-reimport]',
  '',
  '  --home            the OpenFleet home holding openfleet.db (defaults to $OPENFLEET_HOME)',
  '  --dry-run         prints what would be written; writes nothing',
  '  --project         imports only the Scape project of that name',
  '  --scape-dir       the Scape home to read (default ~/.scape; only snapshots of it are opened)',
  '  --report-dir      where import-report.md goes (default: the home)',
  '  --state-dir       the folder of the Scape manager state files <manager name>.md that seed the working states (default ~/Documents/scape-team/state)',
  '  --claude-dir      the Claude config folder that receives each manager\'s auto-memory, under projects/<manager folder>/memory (default ~/.claude)',
  '  --scape-claude-dir  the Claude config folder that holds the Scape managers\' memory (default: --claude-dir)',
  '  --allow-reimport  runs a real import although the target already holds imported projects (a dry run never needs it)',
  '',
  REIMPORT_NOTE,
  '',
].join('\n');

const invalidArguments = (message: string) => new ScapeImportError({ code: 'INVALID_ARGUMENTS', message });

function parseFlags(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: FLAGS, allowPositionals: true });
  } catch (cause) {
    throw invalidArguments((cause as Error).message);
  }
}

type ParsedFlags = ReturnType<typeof parseFlags>;

/** A state folder inside the home of the user must be reached with no link below the home; one elsewhere only has to be no link itself. */
function stateFolderOptionsOf(stateDirFlag: string | undefined, homeDirectory: string): Pick<ImportScapeOptions, 'stateDir' | 'stateRoot'> {
  const stateDir = stateDirFlag ?? join(homeDirectory, 'Documents', 'scape-team', 'state');
  const isInsideHome = relative(homeDirectory, resolve(stateDir)).split(sep)[0] !== '..';
  return { stateDir, stateRoot: isInsideHome ? homeDirectory : undefined };
}

function importOptionsFrom({ values, positionals }: ParsedFlags, environment: CliEnvironment) {
  if (positionals.join(' ') !== 'scape') throw invalidArguments(USAGE);
  const home = values.home ?? environment.env.OPENFLEET_HOME;
  if (home === undefined || home === '') throw invalidArguments('--home <OPENFLEET_HOME> is required (or set OPENFLEET_HOME)');
  const allowsReimport = values['allow-reimport'] ?? false;
  const options: ImportScapeOptions = {
    home,
    scapeDir: values['scape-dir'] ?? join(environment.homeDirectory, '.scape'),
    superpowersRoot: join(environment.homeDirectory, 'Documents', 'superpowers'),
    dryRun: values['dry-run'] ?? false,
    projectName: values.project,
    reportDir: values['report-dir'],
    ...stateFolderOptionsOf(values['state-dir'], environment.homeDirectory),
    claudeDir: values['claude-dir'] ?? join(environment.homeDirectory, '.claude'),
    scapeClaudeDir: values['scape-claude-dir'],
    refuseReimport: !allowsReimport,
  };
  return { options, allowsReimport };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Runs `import scape` with the given arguments and never exits, so the entry point owns the process. Import failures come back as an exit code and their code; a bug propagates. */
export function runImportCli(argv: string[], environment: CliEnvironment): CliResult {
  try {
    const flags = parseFlags(argv);
    if (flags.values.help) return { exitCode: EXIT_OK, output: USAGE };
    const { options, allowsReimport } = importOptionsFrom(flags, environment);
    const report = importScape(options);
    const warning = allowsReimport && !report.dryRun ? `Re-import: ${REIMPORT_NOTE} Check the report for the conflicts, the records deleted in OpenFleet and the records removed in Scape.\n` : '';
    const summary = report.dryRun ? renderImportReport(report) : `Import written. Report: ${report.reportPath}\n`;
    return { exitCode: EXIT_OK, output: `${warning}${summary}` };
  } catch (error) {
    if (!(error instanceof ScapeImportError)) throw error;
    const exitCode = error.code === 'INVALID_ARGUMENTS' ? EXIT_INVALID_ARGUMENTS : EXIT_IMPORT_FAILED;
    const message = error.code === 'INVALID_ARGUMENTS' ? error.message : oneLine(error.message);
    const hint = error.code === 'ALREADY_IMPORTED' ? ' Pass --allow-reimport to run it anyway.' : '';
    return { exitCode, output: `${error.code}: ${message}${hint}\n` };
  }
}
