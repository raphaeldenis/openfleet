import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyReport, hasChanges, renderImportReport, type ImportReport } from './importReport.js';
import { ScapeImportError } from './scapeImportError.js';
import { buildImportPlan, type ImportPlan } from './scapePlan.js';
import { ScapeSource } from './scapeSource.js';
import { backUpCommittedState, openDryRunTarget, openWritableTarget, type TargetDatabase } from './scapeTarget.js';
import { writePlan } from './scapeWriter.js';

export const IMPORT_REPORT_FILE_NAME = 'import-report.md';
const DATABASE_FILE_NAME = 'openfleet.db';
const MANAGERS_FOLDER_NAME = 'managers';
const PRIVATE_FOLDER_MODE = 0o700;

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
    return buildImportPlan(source, { projectName: options.projectName, superpowersRoot: options.superpowersRoot, managersRoot: managersRootOf(options) });
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
    message: `the target already holds imported projects (${names}); a re-import is not yet safe against OpenFleet-side deletions or renames and Scape-side column or option changes (MIG-01B).`,
  });
}

function createManagerFolders(plan: ImportPlan): void {
  for (const { session } of plan.managers) mkdirSync(session.directory, { recursive: true, mode: PRIVATE_FOLDER_MODE });
}

function writeToTarget(plan: ImportPlan, options: ImportScapeOptions): ImportReport {
  const dryRun = options.dryRun ?? false;
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const report = emptyReport({ dryRun });
  const databaseExistedBefore = existsSync(join(options.home, DATABASE_FILE_NAME));
  const mustBackUpBeforeCommit = () => {
    const isOverwritingAnExistingDatabase = !dryRun && databaseExistedBefore && hasChanges(report);
    if (isOverwritingAnExistingDatabase) backUpCommittedState({ home: options.home });
  };
  let target: TargetDatabase | undefined;
  try {
    target = dryRun ? openDryRunTarget({ home: options.home, scratchRoot }) : openWritableTarget(options.home);
    if (options.refuseReimport && !dryRun) assertNoProjectImportedYet(target.db, plan);
    writePlan(target.db, plan, report, mustBackUpBeforeCommit);
    if (!dryRun) createManagerFolders(plan);
    return report;
  } catch (cause) {
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
