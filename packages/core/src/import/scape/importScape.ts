import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadManagerBase } from '../../managers/managerBase.js';
import { addManagerFinding, emptyReport, hasChanges, inlineMarkdownText, renderImportReport, type ImportReport } from './importReport.js';
import { reportManagerMission, type ManagerMissionReport } from './managerMissionReport.js';
import { prepareManagerFolders, type PreparedManagerFolders } from './managerFolders.js';
import { ScapeImportError } from './scapeImportError.js';
import { MemoryFilesJournal } from './scapeMemoriesWriter.js';
import { buildImportPlan, type ImportPlan } from './scapePlan.js';
import { ScapeSource } from './scapeSource.js';
import { backUpCommittedState, openDryRunTarget, openWritableTarget, type TargetDatabase, type UpsertOutcome } from './scapeTarget.js';
import { writePlan } from './scapeWriter.js';

export const IMPORT_REPORT_FILE_NAME = 'import-report.md';
const DATABASE_FILE_NAME = 'openfleet.db';
const MANAGERS_FOLDER_NAME = 'managers';

export interface ImportScapeOptions {
  /** The Scape home to read (`~/.scape`); only a snapshot of it is ever opened. */
  scapeDir: string;
  /** The OpenFleet home holding `openfleet.db`. */
  home: string;
  /** Where the project docs folders live; a folder is linked only when it already exists. */
  superpowersRoot: string;
  dryRun?: boolean;
  projectName?: string;
  /** Where `import-report.md` goes; defaults to the home. */
  reportDir?: string;
  /** Where the temporary snapshots live (removed before returning); defaults to the OS temp folder. */
  scratchRoot?: string;
  /** Refuses a real run when the target already holds one of the projects to import. */
  refuseReimport?: boolean;
  /** Where each imported manager gets its own working folder (created by a real run only); defaults to `managers` in the home. */
  managersRoot?: string;
  /** The folder of the Scape manager state files (`<manager name>.md`) that seed the working states; none given, none seeded. Only its regular files are read. */
  stateDir?: string;
  /** The folder the state folder must be inside, with no link between the two; defaults to the parent of the state folder, so that only the folder itself must not be a link. */
  stateRoot?: string;
  /** The Claude config folder (`~/.claude`) that receives each manager's auto-memory; none given, no memory is read or copied. */
  claudeDir?: string;
  /** The Claude config folder that holds the memory of the Scape managers; defaults to `claudeDir`. */
  scapeClaudeDir?: string;
}

const managersRootOf = (options: ImportScapeOptions) => options.managersRoot ?? join(options.home, MANAGERS_FOLDER_NAME);

function writeReportFile(report: ImportReport, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, IMPORT_REPORT_FILE_NAME);
  writeFileSync(reportPath, renderImportReport(report));
  return reportPath;
}

function planFromScape(source: ScapeSource, options: ImportScapeOptions): ImportPlan {
  try {
    const memorySource = options.claudeDir === undefined ? undefined : { scapeDir: options.scapeDir, scapeClaudeDir: options.scapeClaudeDir ?? options.claudeDir };
    return buildImportPlan(source, { projectName: options.projectName, superpowersRoot: options.superpowersRoot, managersRoot: managersRootOf(options), stateDir: options.stateDir, stateRoot: options.stateRoot, memorySource });
  } catch (cause) {
    if (cause instanceof ScapeImportError) throw cause;
    throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `the Scape data cannot be read: ${(cause as Error).message}`, cause });
  }
}

function assertNoProjectImportedYet(db: DatabaseSync, plan: ImportPlan): void {
  const alreadyImported = plan.projects.filter((project) => db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id) !== undefined);
  if (alreadyImported.length === 0) return;
  const names = alreadyImported.map((project) => project.extra.projectName).join(', ');
  throw new ScapeImportError({
    code: 'ALREADY_IMPORTED',
    message: `the target already holds imported projects (${names}); a re-import applies the Scape changes to the records OpenFleet left alone and reports the others as conflicts. Preview it with --dry-run first.`,
  });
}

const MANAGER_OUTCOMES_NEEDING_A_FOLDER: UpsertOutcome[] = ['written', 'updated', 'alreadyPresent'];

const storedDirectoryOf = (db: DatabaseSync, managerId: string): string | undefined =>
  (db.prepare('SELECT directory FROM sessions WHERE id = ?').get(managerId) as { directory: string } | undefined)?.directory;

interface ManagerFolderChoice { managerName: string; directory: string; plannedDirectory: string }

/** The folder of each manager kept: the one already stored for a manager already present, else the planned one. */
function folderChoicesOfManagersKept(input: { plan: ImportPlan; outcomes: Map<string, UpsertOutcome>; db: DatabaseSync }): ManagerFolderChoice[] {
  const managersKept = input.plan.managers.filter((manager) => MANAGER_OUTCOMES_NEEDING_A_FOLDER.includes(input.outcomes.get(manager.id)!));
  return managersKept.map((manager) => ({
    managerName: manager.session.name,
    directory: storedDirectoryOf(input.db, manager.id) ?? manager.session.directory,
    plannedDirectory: manager.session.directory,
  }));
}

/** A stored folder that is relative or was moved out of the managers root by hand is not the import's to prepare. */
const isFolderOfManagersRoot = (managersRoot: string) => (directory: string): boolean => isAbsolute(directory) && dirname(resolve(directory)) === resolve(managersRoot);

function reportFoldersNeedingALook(report: ImportReport, input: { choices: ManagerFolderChoice[]; isFolderOfRoot: (directory: string) => boolean }): void {
  for (const { managerName, directory, plannedDirectory } of input.choices) {
    const isLeftAsItIs = !input.isFolderOfRoot(directory);
    const isKeptUnderAnotherName = !isLeftAsItIs && directory !== plannedDirectory;
    if (isLeftAsItIs) addManagerFinding(report, { managerName, text: 'stored folder is outside managers/, left as it is' });
    if (isKeptUnderAnotherName) addManagerFinding(report, { managerName, text: `folder kept as ${inlineMarkdownText(basename(directory))}, its name now maps to ${inlineMarkdownText(basename(plannedDirectory))}` });
  }
}

function managerMissionsOf(plan: ImportPlan): ManagerMissionReport[] {
  const baseSections = loadManagerBase().sections;
  return plan.managers.map((manager) => reportManagerMission({ managerId: manager.id, name: manager.session.name, missionText: manager.manager.missionText }, baseSections));
}

function writeToTarget(plan: ImportPlan, options: ImportScapeOptions): ImportReport {
  const dryRun = options.dryRun ?? false;
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const report = { ...emptyReport({ dryRun }), ...plan.sourceLosses, managerMissions: managerMissionsOf(plan), laws: { ...plan.lawsReport, perManager: [] } };
  const databaseExistedBefore = existsSync(join(options.home, DATABASE_FILE_NAME));
  const mustBackUpBeforeCommit = () => {
    const isOverwritingAnExistingDatabase = !dryRun && databaseExistedBefore && hasChanges(report);
    if (isOverwritingAnExistingDatabase) backUpCommittedState({ home: options.home });
  };
  let preparedFolders: PreparedManagerFolders | undefined;
  const prepareFoldersBeforeCommit = (managerOutcomes: Map<string, UpsertOutcome>) => {
    const folderChoices = folderChoicesOfManagersKept({ plan, outcomes: managerOutcomes, db: target!.db });
    const isFolderOfRoot = isFolderOfManagersRoot(managersRootOf(options));
    reportFoldersNeedingALook(report, { choices: folderChoices, isFolderOfRoot });
    if (dryRun) return;
    const directoriesToPrepare = folderChoices.map((choice) => choice.directory).filter(isFolderOfRoot);
    preparedFolders = prepareManagerFolders({ managersRoot: managersRootOf(options), directories: directoriesToPrepare, forbiddenRoot: options.scapeDir });
    mustBackUpBeforeCommit();
  };
  const memoryFilesJournal = new MemoryFilesJournal();
  const memories = options.claudeDir === undefined ? undefined : { claudeDir: options.claudeDir, dryRun, journal: memoryFilesJournal };
  let target: TargetDatabase | undefined;
  try {
    target = dryRun ? openDryRunTarget({ home: options.home, scratchRoot }) : openWritableTarget(options.home);
    if (options.refuseReimport && !dryRun) assertNoProjectImportedYet(target.db, plan);
    writePlan(target.db, plan, report, { coversEveryProject: options.projectName === undefined, memories }, prepareFoldersBeforeCommit);
    return report;
  } catch (cause) {
    preparedFolders?.rollback();
    memoryFilesJournal.rollback();
    if (cause instanceof ScapeImportError) throw cause;
    throw new ScapeImportError({ code: 'IMPORT_WRITE_FAILED', message: `the import could not write to ${options.home}: ${(cause as Error).message}`, cause });
  } finally {
    target?.dispose();
  }
}

/** Imports the Scape projects, notes, data stores and row history into an OpenFleet home. Idempotent: the Scape id is the OpenFleet id. */
export function importScape(options: ImportScapeOptions): ImportReport {
  const source = new ScapeSource(options.scapeDir, options.scratchRoot);
  try {
    const plan = planFromScape(source, options);
    const report = writeToTarget(plan, options);
    if (!report.dryRun) report.reportPath = writeReportFile(report, options.reportDir ?? options.home);
    return report;
  } finally {
    source.close();
  }
}
