import { closeSync, constants, fstatSync, ftruncateSync, openSync, writeFileSync } from 'node:fs';
import { assertNoSymlink, KnowledgeImportError, type KnowledgeRejectionReason } from './knowledgeExportSchema.js';
import type { KnowledgeAuthority } from '../../knowledge/knowledgeTypes.js';

export interface KnowledgeCounts {
  source_rows: number;
  source_active: number;
  source_retired: number;
  inserted: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  rejected: number;
  missing_source: number;
  missing_target: number;
}

export interface KnowledgeImportReport extends KnowledgeCounts {
  success: boolean;
  dry_run: boolean;
  committed: boolean;
  reason: KnowledgeRejectionReason | null;
  repositories: (KnowledgeCounts & { repository: number; authority: KnowledgeAuthority })[];
}

export const emptyKnowledgeCounts = (): KnowledgeCounts => ({ source_rows: 0, source_active: 0, source_retired: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, missing_source: 0, missing_target: 0 });

export function rejectedKnowledgeReport(input: { reason: KnowledgeRejectionReason; dryRun: boolean }): KnowledgeImportReport {
  return { ...emptyKnowledgeCounts(), success: false, dry_run: input.dryRun, committed: false, rejected: 1, reason: input.reason, repositories: [] };
}

export const renderKnowledgeReport = (report: KnowledgeImportReport): string => `${JSON.stringify(report)}\n`;

export function assertReportTarget(path: string): void {
  try { assertNoSymlink(path); }
  catch (error) {
    if (error instanceof KnowledgeImportError) throw error;
    throw new KnowledgeImportError('REPORT_WRITE_FAILED');
  }
}

export function persistKnowledgeReport(input: { path: string; report: KnowledgeImportReport }): void {
  let descriptor: number | undefined;
  try {
    assertReportTarget(input.path);
    descriptor = openSync(input.path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    if (!fstatSync(descriptor).isFile()) throw new KnowledgeImportError('REPORT_WRITE_FAILED');
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, renderKnowledgeReport(input.report));
  } catch { throw new KnowledgeImportError('REPORT_WRITE_FAILED'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
