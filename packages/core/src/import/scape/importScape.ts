import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyReport, hasChanges, renderImportReport, type ImportReport } from './importReport.js';
import { ScapeImportError } from './scapeImportError.js';
import { buildImportPlan, type ImportPlan } from './scapePlan.js';
import { ScapeSource } from './scapeSource.js';
import { backUpCommittedState, openDryRunTarget, openWritableTarget } from './scapeTarget.js';
import { writePlan } from './scapeWriter.js';

export const IMPORT_REPORT_FILE_NAME = 'import-report.md';
const DATABASE_FILE_NAME = 'openfleet.db';

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
}

function writeReportFile(report: ImportReport, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, IMPORT_REPORT_FILE_NAME);
  writeFileSync(reportPath, renderImportReport(report));
  return reportPath;
}

function planFromScape(source: ScapeSource, options: ImportScapeOptions): ImportPlan {
  try {
    return buildImportPlan(source, { projectName: options.projectName, superpowersRoot: options.superpowersRoot });
  } catch (cause) {
    if (cause instanceof ScapeImportError) throw cause;
    throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `the Scape data cannot be read: ${(cause as Error).message}`, cause });
  }
}

function writeToTarget(plan: ImportPlan, options: ImportScapeOptions): ImportReport {
  const dryRun = options.dryRun ?? false;
  const report = emptyReport({ dryRun });
  const databaseExistedBefore = existsSync(join(options.home, DATABASE_FILE_NAME));
  const target = dryRun ? openDryRunTarget(options.home) : openWritableTarget(options.home);
  const mustBackUpBeforeCommit = () => {
    const isOverwritingAnExistingDatabase = !dryRun && databaseExistedBefore && hasChanges(report);
    if (isOverwritingAnExistingDatabase) backUpCommittedState({ home: options.home });
  };
  try {
    writePlan(target.db, plan, report, mustBackUpBeforeCommit);
    return report;
  } catch (cause) {
    if (cause instanceof ScapeImportError) throw cause;
    throw new ScapeImportError({ code: 'IMPORT_WRITE_FAILED', message: `the import could not write to ${options.home}: ${(cause as Error).message}`, cause });
  } finally {
    target.dispose();
  }
}

/** Imports the Scape projects, notes, data stores and row history into an OpenFleet home. Idempotent: the Scape id is the OpenFleet id. */
export function importScape(options: ImportScapeOptions): ImportReport {
  const source = new ScapeSource(options.scapeDir);
  try {
    const plan = planFromScape(source, options);
    const report = writeToTarget(plan, options);
    if (!report.dryRun) report.reportPath = writeReportFile(report, options.reportDir ?? options.home);
    return report;
  } finally {
    source.close();
  }
}
