import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyReport, renderImportReport, type ImportReport } from './importReport.js';
import { ScapeImportError } from './scapeImportError.js';
import { buildImportPlan } from './scapePlan.js';
import { ScapeSource } from './scapeSource.js';
import { openDryRunTarget, openWritableTarget } from './scapeTarget.js';
import { writePlan } from './scapeWriter.js';

export const IMPORT_REPORT_FILE_NAME = 'import-report.md';

export interface ImportScapeOptions {
  /** The Scape home to read (`~/.scape`); only ever opened read-only. */
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

/** Imports the Scape projects, notes, data stores and row history into an OpenFleet home. Idempotent: the Scape id is the OpenFleet id. */
export function importScape(options: ImportScapeOptions): ImportReport {
  const dryRun = options.dryRun ?? false;
  const source = new ScapeSource(options.scapeDir);
  try {
    const plan = buildImportPlan(source, { projectName: options.projectName, superpowersRoot: options.superpowersRoot });
    const report = emptyReport({ dryRun });
    const target = dryRun ? openDryRunTarget(options.home) : openWritableTarget(options.home);
    try {
      writePlan(target.db, plan, report);
    } catch (cause) {
      if (cause instanceof ScapeImportError) throw cause;
      throw new ScapeImportError({ code: 'IMPORT_WRITE_FAILED', message: `the import could not write to ${options.home}: ${(cause as Error).message}`, cause });
    } finally {
      target.dispose();
    }
    if (!dryRun) report.reportPath = writeReportFile(report, options.reportDir ?? options.home);
    return report;
  } finally {
    source.close();
  }
}
