import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { runCleanLaws, type CleanLawsRequest } from './cleanLawsCommand.js';
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
  json: { type: 'boolean' },
  apply: { type: 'boolean' },
  confirm: { type: 'string' },
  help: { type: 'boolean' },
} as const;

const CLEAN_LAWS_COMMAND = 'clean-laws';

const REIMPORT_NOTE =
  'A re-import compares each record with what the last import wrote: a Scape change is applied to a record OpenFleet left alone; a record edited or deleted in OpenFleet is a conflict and is kept (a deleted one is never written again); a record removed in Scape is reported and kept. The approved Scape laws are written to the laws table the same way: a law edited, withdrawn or deleted in OpenFleet is never overwritten, reactivated or written again. The laws are no longer copied into the manager mission, so an imported manager whose mission is intact has it rewritten without them (updated) and one edited in OpenFleet is a conflict and keeps its text. Run --dry-run first to see the outcome per entity.';

const USAGE = [
  'usage: import scape --home <OPENFLEET_HOME> [--dry-run] [--project <name>] [--scape-dir <dir>] [--report-dir <dir>] [--state-dir <dir>] [--claude-dir <dir>] [--scape-claude-dir <dir>] [--allow-reimport] [--json]',
  '',
  '  --home           the OpenFleet home holding openfleet.db (defaults to $OPENFLEET_HOME)',
  '  --dry-run         prints what would be written; writes nothing',
  '  --project         imports only the Scape project of that name',
  '  --scape-dir       the Scape home to read (default ~/.scape; only snapshots of it are opened)',
  '  --report-dir      where import-report.md goes (default: the home); a dry run writes no report file',
  '  --state-dir       the folder of the Scape manager state files <manager name>.md that seed the working states (default ~/Documents/scape-team/state)',
  '  --claude-dir      the Claude config folder that receives each manager\'s auto-memory, under projects/<manager folder>/memory (default ~/.claude)',
  '  --scape-claude-dir  the Claude config folder that holds the Scape managers\' memory (default: --claude-dir)',
  '  --json            prints the report as JSON instead of text (a dry run: nothing is written)',
  '  --allow-reimport  runs a real import although the target already holds imported projects (a dry run never needs it)',
  '',
  'usage: import scape clean-laws --home <OPENFLEET_HOME> [--apply --confirm <fingerprint>] [--json]',
  '',
  '  Removes from the imported managers\' missions the Standing laws copies that the laws table already holds. Without --apply it prints the plan (counts and a fingerprint) and writes nothing.',
  '  --apply           writes the cleanup, after a backup of the database; refused while the OpenFleet daemon runs',
  '  --confirm         the fingerprint printed by the plan; without it, or with a stale one, --apply is refused: read the plan again',
  '  Copies written by hand in the notes are never touched; they are only counted.',
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

function homeFrom({ values }: ParsedFlags, environment: CliEnvironment): string {
  const home = values.home ?? environment.env.OPENFLEET_HOME;
  if (home === undefined || home === '') throw invalidArguments('--home <OPENFLEET_HOME> is required (or set OPENFLEET_HOME)');
  return home;
}

function cleanLawsRequestFrom(flags: ParsedFlags, environment: CliEnvironment): CleanLawsRequest {
  const { values } = flags;
  const applies = values.apply ?? false;
  if (values.confirm !== undefined && !applies) throw invalidArguments('--confirm only goes with --apply');
  return { home: homeFrom(flags, environment), applies, confirm: values.confirm, asJson: values.json ?? false };
}

function importOptionsFrom(flags: ParsedFlags, environment: CliEnvironment) {
  const { values, positionals } = flags;
  if (positionals.join(' ') !== 'scape') throw invalidArguments(USAGE);
  if (values.apply || values.confirm !== undefined) throw invalidArguments(`--apply and --confirm belong to \`import scape ${CLEAN_LAWS_COMMAND}\``);
  const home = homeFrom(flags, environment);
  const allowsReimport = values['allow-reimport'] ?? false;
  const options: ImportScapeOptions = {
    home,
    scapeDir: values['scape-dir'] ?? join(environment.homeDirectory, '.scape'),
    superpowersRoot: join(environment.homeDirectory, 'Documents', 'superpowers'),
    dryRun: (values['dry-run'] ?? false) || (values.json ?? false),
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
    const isCleanLaws = flags.positionals.join(' ') === `scape ${CLEAN_LAWS_COMMAND}`;
    if (isCleanLaws) return { exitCode: EXIT_OK, output: runCleanLaws(cleanLawsRequestFrom(flags, environment)) };
    const { options, allowsReimport } = importOptionsFrom(flags, environment);
    const report = importScape(options);
    if (flags.values.json) return { exitCode: EXIT_OK, output: `${JSON.stringify(report, null, 2)}\n` };
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
